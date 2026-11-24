import {
	BlockedReason,
	FinishReason,
	type GenerateContentParameters,
	type GenerateContentResponse,
	type ImageConfig,
	type Part,
} from "@google/genai";
import { calculateCost } from "../models.ts";
import type {
	AssistantImages,
	ImageApi,
	ImageContent,
	ImageModel,
	ImagesContext,
	ImagesFunction,
	ImagesOptions,
	TextContent,
	Usage,
} from "../types.ts";
import { formatProviderError, normalizeProviderError } from "../utils/error-body.ts";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.ts";
import {
	createGoogleClient,
	createGoogleFetch,
	resolveGoogleApiKey,
	retryGoogleRequest,
	sendsToGeminiApi,
} from "./google-client.ts";

/**
 * Native Google Gemini image generation over `POST /v1beta/models/{model}:generateContent`
 * (Nano Banana 2.1 / Nano Banana 2 Lite / Nano Banana Pro).
 */
export const generateImages: ImagesFunction<ImagesOptions> = async (
	model: ImageModel<ImageApi>,
	context: ImagesContext,
	options?: ImagesOptions,
) => {
	const output: AssistantImages = {
		api: model.api,
		provider: model.provider,
		model: model.id,
		output: [],
		stopReason: "stop",
		timestamp: Date.now(),
	};

	try {
		const apiKey = resolveGoogleApiKey(model, options?.apiKey, options?.headers);
		if (!apiKey) {
			throw new Error(`No API key for provider: ${model.provider}`);
		}
		let lastFailedHeaders: Headers | undefined;
		const googleFetch = createGoogleFetch("Google", model, options, (headers) => {
			lastFailedHeaders = headers;
		});
		const client = createGoogleClient(model, apiKey, options?.headers, options?.identity, googleFetch);

		let params = buildParams(model, context, options);
		const nextParams = await options?.onPayload?.(params, model);
		if (nextParams !== undefined) {
			params = nextParams as GenerateContentParameters;
		}

		const response = await retryGoogleRequest(
			() => {
				lastFailedHeaders = undefined;
				return client.models.generateContent(params);
			},
			options,
			() => lastFailedHeaders,
		);

		output.responseId = response.responseId;
		if (response.usageMetadata) {
			output.usage = parseUsage(response.usageMetadata, model);
		}

		const blockReason = response.promptFeedback?.blockReason;
		if (blockReason && blockReason !== BlockedReason.BLOCKED_REASON_UNSPECIFIED) {
			const blockReasonMessage = response.promptFeedback?.blockReasonMessage;
			throw new Error(
				blockReasonMessage
					? `Prompt blocked (${blockReason}): ${blockReasonMessage}`
					: `Prompt blocked: ${blockReason}`,
			);
		}

		const candidate = response.candidates?.[0];
		const finishReason = candidate?.finishReason;
		if (finishReason && finishReason !== FinishReason.STOP && finishReason !== FinishReason.MAX_TOKENS) {
			throw new Error(`Provider stopped with: ${finishReason}`);
		}

		for (const part of candidate?.content?.parts ?? []) {
			// Skip internal thinking text and intermediate thought images emitted by Nano Banana 2/2.1/Pro.
			if (part.thought === true) continue;
			if (typeof part.text === "string" && part.text.length > 0) {
				output.output.push({ type: "text", text: part.text } satisfies TextContent);
			}
			if (part.inlineData?.data && part.inlineData?.mimeType) {
				output.output.push({
					type: "image",
					mimeType: part.inlineData.mimeType,
					data: part.inlineData.data,
				} satisfies ImageContent);
			}
		}

		return output;
	} catch (error) {
		output.stopReason = options?.signal?.aborted ? "aborted" : "error";
		output.errorMessage = formatProviderError(normalizeProviderError(error));
		return output;
	}
};

function buildParams(
	model: ImageModel<ImageApi>,
	context: ImagesContext,
	options?: ImagesOptions,
): GenerateContentParameters {
	const parts: Part[] = context.input.map((item): Part => {
		if (item.type === "text") {
			return { text: sanitizeSurrogates(item.text) };
		}
		return {
			inlineData: {
				mimeType: item.mimeType,
				data: item.data,
			},
		};
	});

	const imageConfig: ImageConfig = {};
	if (options?.aspectRatio !== undefined) imageConfig.aspectRatio = options.aspectRatio;
	if (options?.imageSize !== undefined) imageConfig.imageSize = options.imageSize;

	return {
		model: model.id,
		contents: [{ role: "user", parts }],
		config: {
			// Opt out of Gemini Developer API request logging (matches google-generative-ai chat).
			...(sendsToGeminiApi(model) && { store: false }),
			responseModalities: model.output.includes("text") ? ["TEXT", "IMAGE"] : ["IMAGE"],
			...(Object.keys(imageConfig).length > 0 ? { imageConfig } : {}),
			...(options?.signal ? { abortSignal: options.signal } : {}),
		},
	};
}

function parseUsage(
	usageMetadata: NonNullable<GenerateContentResponse["usageMetadata"]>,
	model: ImageModel<ImageApi>,
): Usage {
	const promptTokens = usageMetadata.promptTokenCount || 0;
	const cacheRead = usageMetadata.cachedContentTokenCount || 0;
	const thoughts = usageMetadata.thoughtsTokenCount || 0;
	const outputTokens = (usageMetadata.candidatesTokenCount || 0) + thoughts;
	const usage: Usage = {
		input: Math.max(0, promptTokens - cacheRead),
		output: outputTokens,
		cacheRead,
		cacheWrite: 0,
		...(thoughts > 0 ? { reasoning: thoughts } : {}),
		totalTokens: usageMetadata.totalTokenCount || promptTokens + outputTokens,
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0,
		},
	};
	calculateCost(model, usage);
	return usage;
}
