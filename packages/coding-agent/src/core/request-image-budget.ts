import { createHash } from "node:crypto";
import type {
	Api,
	ImageContent,
	Message,
	Model,
	TextContent,
	ToolResultMessage,
	TranscriptContext,
	UserMessage,
} from "@earendil-works/pi-ai";
import { LRUCache } from "lru-cache";
import {
	DEFAULT_IMAGE_RESIZE_MAX_BYTES,
	formatDimensionNote,
	type ImageResizeOptions,
	type ResizedImage,
	resizeImage,
} from "../utils/image-resize.ts";

/**
 * Matches Google's 100 MiB inline request payload limit (`packages/ai/src/api/google-catalog.ts`),
 * the largest inline multimodal `maxRequestBytes` limit across Google (100 MiB), Anthropic (32 MiB),
 * and Bedrock (25 MiB), so a single full-limit request never evicts its own prefix entries.
 */
const DEFAULT_IMAGE_FIT_CACHE_MAX_BYTES = 100 * 1024 * 1024;

const OMITTED_PER_MESSAGE_TEXT = "[Image omitted: exceeds model per-message image limit.]";
const OMITTED_PER_REQUEST_TEXT = "[Image omitted: exceeds model per-request image limit.]";
const OMITTED_REQUEST_BYTES_TEXT = "[Image omitted: exceeds model request size limit.]";

export interface EffectiveImageRequestLimits {
	maxRequestBytes?: number;
	maxImagesPerRequest?: number;
	maxImagesPerMessage?: number;
	resizeOptions?: ImageResizeOptions;
}

export interface CachedResizeResult {
	result: ResizedImage | null;
}

export type RequestImageFitCache = LRUCache<string, CachedResizeResult>;

function isPositiveLimit(value: number | undefined): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 1;
}

export function resolveEffectiveImageRequestLimits(model: Model<Api>): EffectiveImageRequestLimits | undefined {
	if (!model.input.includes("image")) return undefined;

	const maxRequestBytes = isPositiveLimit(model.inputLimits?.maxRequestBytes)
		? Math.floor(model.inputLimits.maxRequestBytes)
		: undefined;
	const maxImagesPerRequest = isPositiveLimit(model.inputLimits?.images?.maxPerRequest)
		? Math.floor(model.inputLimits.images.maxPerRequest)
		: undefined;
	const maxImagesPerMessage = isPositiveLimit(model.inputLimits?.images?.maxPerMessage)
		? Math.floor(model.inputLimits.images.maxPerMessage)
		: undefined;

	if (maxRequestBytes === undefined && maxImagesPerRequest === undefined && maxImagesPerMessage === undefined) {
		return undefined;
	}

	return {
		...(maxRequestBytes !== undefined ? { maxRequestBytes } : {}),
		...(maxImagesPerRequest !== undefined ? { maxImagesPerRequest } : {}),
		...(maxImagesPerMessage !== undefined ? { maxImagesPerMessage } : {}),
		...(model.inputLimits?.images?.resize ? { resizeOptions: model.inputLimits.images.resize } : {}),
	};
}

function cacheKey(sourceData: string, sourceMimeType: string, options?: ImageResizeOptions): string {
	const hash = createHash("sha256");
	hash.update(sourceMimeType);
	hash.update("\0");
	hash.update(
		`${options?.maxWidth ?? ""}|${options?.maxHeight ?? ""}|${options?.maxBytes ?? ""}|${options?.jpegQuality ?? ""}`,
	);
	hash.update("\0");
	hash.update(sourceData);
	return hash.digest("hex");
}

/**
 * Bounded LRU cache of resized image outputs keyed by SHA-256 of source bytes and resize options.
 * Stores only resized outputs (never retains full-size source strings), so repeated turns and
 * cache-warming replays emit byte-identical images without redoing Photon work.
 */
export function createRequestImageFitCache(maxSize: number = DEFAULT_IMAGE_FIT_CACHE_MAX_BYTES): RequestImageFitCache {
	return new LRUCache<string, CachedResizeResult>({
		maxSize,
		sizeCalculation: (entry) => Math.max(1, entry.result ? entry.result.data.length : 1),
	});
}

async function resizeCached(
	cache: RequestImageFitCache,
	sourceData: string,
	sourceMimeType: string,
	options?: ImageResizeOptions,
): Promise<ResizedImage | null> {
	const key = cacheKey(sourceData, sourceMimeType, options);
	const cached = cache.get(key);
	if (cached !== undefined) return cached.result;

	const result = await resizeImage(Buffer.from(sourceData, "base64"), sourceMimeType, options).catch(() => null);
	cache.set(key, { result });
	return result;
}

type ImageBearingMessage =
	| (Omit<UserMessage, "content"> & { content: (TextContent | ImageContent)[] })
	| ToolResultMessage;

function isImageBearingMessage(message: Message): message is ImageBearingMessage {
	return (message.role === "user" || message.role === "toolResult") && Array.isArray(message.content);
}

function jsonBytes(value: unknown): number {
	return Buffer.byteLength(JSON.stringify(value), "utf8");
}

/** Measure only the wire-serialized portion of a message (excludes local toolResult details/usage/nestedCalls). */
function measureWireMessageBytes(message: Message): number {
	switch (message.role) {
		case "system":
			return jsonBytes({
				role: message.role,
				content: message.content,
				...(message.sections ? { sections: message.sections } : {}),
				...(message.toolsAdded ? { toolsAdded: message.toolsAdded } : {}),
				...(message.toolsRemoved ? { toolsRemoved: message.toolsRemoved } : {}),
				...(message.providerSummary ? { providerSummary: message.providerSummary } : {}),
			});
		case "user":
			return jsonBytes({ role: message.role, content: message.content });
		case "assistant":
			return jsonBytes({ role: message.role, content: message.content });
		case "toolResult":
			return jsonBytes({
				role: message.role,
				toolCallId: message.toolCallId,
				toolName: message.toolName,
				isError: message.isError,
				content: message.content,
			});
	}
}

function roughWireUpperBoundBytes(messages: readonly Message[]): number {
	let imageBytes = 0;
	let nonImageChars = 0;
	for (const message of messages) {
		if (message.role === "system") {
			if (typeof message.content === "string") {
				nonImageChars += message.content.length;
			} else {
				for (const part of message.content) {
					nonImageChars += part.text.length + 32;
				}
			}
			if (message.sections) nonImageChars += JSON.stringify(message.sections).length;
			if (message.toolsAdded) nonImageChars += JSON.stringify(message.toolsAdded).length;
			if (message.toolsRemoved) nonImageChars += message.toolsRemoved.length * 40;
			if (message.providerSummary) nonImageChars += JSON.stringify(message.providerSummary).length;
		} else if (message.role === "user") {
			if (typeof message.content === "string") {
				nonImageChars += message.content.length;
			} else {
				for (const part of message.content) {
					if (part.type === "image") imageBytes += part.data.length + part.mimeType.length + 64;
					else nonImageChars += part.text.length + 32;
				}
			}
		} else if (message.role === "toolResult") {
			nonImageChars += message.toolCallId.length + message.toolName.length + 64;
			for (const part of message.content) {
				if (part.type === "image") imageBytes += part.data.length + part.mimeType.length + 64;
				else nonImageChars += part.text.length + 32;
			}
		} else if (message.role === "assistant") {
			for (const part of message.content) {
				if (part.type === "text") {
					nonImageChars += part.text.length + (part.textSignature?.length ?? 0) + 48;
				} else if (part.type === "thinking") {
					nonImageChars += part.thinking.length + (part.thinkingSignature?.length ?? 0) + 48;
				} else if (part.type === "toolCall") {
					nonImageChars +=
						part.name.length +
						part.id.length +
						(part.thoughtSignature?.length ?? 0) +
						JSON.stringify(part.arguments).length +
						64;
				}
			}
		}
	}
	// UTF-8 multi-byte + JSON escaping worst-case multiplier for non-base64 text.
	return imageBytes + nonImageChars * 4 + messages.length * 128;
}

interface ImageSlot {
	messageIndex: number;
	partIndex: number;
	sourceData: string;
	sourceMimeType: string;
	currentPart: ImageContent | TextContent;
	notePart?: TextContent;
	currentBytes: number;
	dropped: boolean;
	exhausted: boolean;
}

function slotSerializedBytes(part: ImageContent | TextContent, notePart?: TextContent): number {
	return jsonBytes(part) + (notePart ? jsonBytes(notePart) + 1 : 0);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) {
		throw new Error("Request aborted");
	}
}

function buildUpdatedMessages(messages: readonly Message[], slots: readonly ImageSlot[]): Message[] {
	const slotsByMessage = new Map<number, ImageSlot[]>();
	for (const slot of slots) {
		const list = slotsByMessage.get(slot.messageIndex);
		if (list) list.push(slot);
		else slotsByMessage.set(slot.messageIndex, [slot]);
	}

	const nextMessages = [...messages];
	for (const [messageIndex, messageSlots] of slotsByMessage) {
		const original = messages[messageIndex];
		if (!isImageBearingMessage(original)) continue;
		const byPart = new Map<number, ImageSlot>();
		let messageChanged = false;
		for (const slot of messageSlots) {
			byPart.set(slot.partIndex, slot);
			if (slot.dropped || slot.currentPart !== original.content[slot.partIndex] || slot.notePart !== undefined) {
				messageChanged = true;
			}
		}
		if (!messageChanged) continue;

		const nextContent: (TextContent | ImageContent)[] = [];
		for (let i = 0; i < original.content.length; i++) {
			const slot = byPart.get(i);
			if (!slot) {
				nextContent.push(original.content[i]!);
				continue;
			}
			nextContent.push(slot.currentPart);
			if (!slot.dropped && slot.notePart) {
				nextContent.push(slot.notePart);
			}
		}
		nextMessages[messageIndex] = { ...original, content: nextContent };
	}
	return nextMessages;
}

function dropSlot(slot: ImageSlot, reasonText: string): number {
	const replacement: TextContent = { type: "text", text: reasonText };
	const nextBytes = slotSerializedBytes(replacement);
	const delta = nextBytes - slot.currentBytes;
	slot.currentPart = replacement;
	slot.notePart = undefined;
	slot.currentBytes = nextBytes;
	slot.dropped = true;
	return delta;
}

function applyResizedSlot(slot: ImageSlot, resized: ResizedImage): number {
	const nextPart: ImageContent = {
		type: "image",
		data: resized.data,
		mimeType: resized.mimeType,
	};
	const dimensionsChanged = resized.width !== resized.originalWidth || resized.height !== resized.originalHeight;
	const note = dimensionsChanged ? formatDimensionNote(resized) : undefined;
	const notePart: TextContent | undefined = note ? { type: "text", text: note } : undefined;
	const nextBytes = slotSerializedBytes(nextPart, notePart);
	if (nextBytes >= slot.currentBytes) {
		return 0;
	}
	const delta = nextBytes - slot.currentBytes;
	slot.currentPart = nextPart;
	slot.notePart = notePart;
	slot.currentBytes = nextBytes;
	return delta;
}

/**
 * Enforce `model.inputLimits` (`maxRequestBytes`, `images.maxPerMessage`, `images.maxPerRequest`)
 * on a projected transcript context without mutating saved session history.
 *
 * When the request already fits within all active limits, returns `context` unchanged so images
 * remain at full resolution with zero resizing overhead. When a limit would be exceeded, shrinks
 * oldest images first via Pi's native `resizeImage()` so the most recent images stay full-size
 * whenever possible, omitting oldest images only as a last resort.
 */
export async function fitContextImagesToRequestLimit(
	model: Model<Api>,
	context: TranscriptContext,
	cache: RequestImageFitCache = createRequestImageFitCache(),
	signal?: AbortSignal,
): Promise<TranscriptContext> {
	const limits = resolveEffectiveImageRequestLimits(model);
	if (!limits) return context;

	const slots: ImageSlot[] = [];
	const slotsByMessage = new Map<number, ImageSlot[]>();
	let maxImagesInAnyMessage = 0;

	for (let messageIndex = 0; messageIndex < context.messages.length; messageIndex++) {
		const message = context.messages[messageIndex]!;
		if (!isImageBearingMessage(message)) continue;
		let countInMessage = 0;
		for (let partIndex = 0; partIndex < message.content.length; partIndex++) {
			const part = message.content[partIndex]!;
			if (part.type !== "image") continue;
			countInMessage++;
			const slot: ImageSlot = {
				messageIndex,
				partIndex,
				sourceData: part.data,
				sourceMimeType: part.mimeType,
				currentPart: part,
				currentBytes: 0,
				dropped: false,
				exhausted: false,
			};
			slots.push(slot);
			const list = slotsByMessage.get(messageIndex);
			if (list) list.push(slot);
			else slotsByMessage.set(messageIndex, [slot]);
		}
		if (countInMessage > maxImagesInAnyMessage) maxImagesInAnyMessage = countInMessage;
	}

	if (slots.length === 0) return context;

	const exceedsPerMessage =
		limits.maxImagesPerMessage !== undefined && maxImagesInAnyMessage > limits.maxImagesPerMessage;
	const exceedsPerRequest = limits.maxImagesPerRequest !== undefined && slots.length > limits.maxImagesPerRequest;

	if (!exceedsPerMessage && !exceedsPerRequest) {
		if (limits.maxRequestBytes === undefined) return context;
		if (roughWireUpperBoundBytes(context.messages) <= limits.maxRequestBytes) return context;
	}

	// Exact wire-byte accounting only when near/above a limit.
	let totalBytes = 2; // JSON array framing
	for (const message of context.messages) {
		totalBytes += measureWireMessageBytes(message) + 1;
	}
	for (const slot of slots) {
		slot.currentBytes = slotSerializedBytes(slot.currentPart);
	}

	const maxRequestBytes = limits.maxRequestBytes;
	if (!exceedsPerMessage && !exceedsPerRequest && (maxRequestBytes === undefined || totalBytes <= maxRequestBytes)) {
		return context;
	}

	let changed = false;

	// Phase 1a: enforce per-message image count cap (drop oldest images in each over-limit message).
	if (limits.maxImagesPerMessage !== undefined) {
		for (const messageSlots of slotsByMessage.values()) {
			const excess = messageSlots.length - limits.maxImagesPerMessage;
			for (let i = 0; i < excess; i++) {
				totalBytes += dropSlot(messageSlots[i]!, OMITTED_PER_MESSAGE_TEXT);
				changed = true;
			}
		}
	}

	// Phase 1b: enforce per-request image count cap (drop oldest remaining images across the request).
	if (limits.maxImagesPerRequest !== undefined) {
		const active = slots.filter((slot) => !slot.dropped);
		const excess = active.length - limits.maxImagesPerRequest;
		for (let i = 0; i < excess; i++) {
			totalBytes += dropSlot(active[i]!, OMITTED_PER_REQUEST_TEXT);
			changed = true;
		}
	}

	if (maxRequestBytes !== undefined && totalBytes > maxRequestBytes) {
		const omittedBytes = slotSerializedBytes({ type: "text", text: OMITTED_REQUEST_BYTES_TEXT });
		const activeImages = slots.filter((slot) => !slot.dropped);
		const nonImageBytes =
			totalBytes - activeImages.reduce((sum, slot) => sum + Math.max(0, slot.currentBytes - omittedBytes), 0);

		// Phase 2: if text/tool history alone exceeds maxRequestBytes, image changes cannot make the request fit.
		if (nonImageBytes <= maxRequestBytes) {
			const configuredMaxBytes = limits.resizeOptions?.maxBytes ?? DEFAULT_IMAGE_RESIZE_MAX_BYTES;

			// Phase 3: gentle oldest-first resize using the model's resize profile (keeps newest full-size).
			// Cap maxBytes at this image's own source base64 length (intrinsic to the image, independent of
			// later turns for prompt-cache stability) so uncompressed PNGs within 2000x2000 still re-encode
			// to compact JPEG instead of short-circuiting unchanged.
			for (const slot of activeImages) {
				if (totalBytes <= maxRequestBytes) break;
				throwIfAborted(signal);
				const gentleOptions: ImageResizeOptions = {
					...limits.resizeOptions,
					maxBytes: Math.min(configuredMaxBytes, slot.sourceData.length),
				};
				const resized = await resizeCached(cache, slot.sourceData, slot.sourceMimeType, gentleOptions);
				if (resized) {
					const delta = applyResizedSlot(slot, resized);
					if (delta < 0) {
						totalBytes += delta;
						changed = true;
					}
				}
			}

			// Phase 4: tighter oldest-first resize through deterministic halving steps from `configuredMaxBytes`.
			// Because each step depends only on the model's resize cap (not session-wide excess), historical
			// images hit the same cache keys and remain byte-identical as later turns append.
			for (
				let tierMaxBytes = Math.floor(configuredMaxBytes / 2);
				tierMaxBytes >= 1 && totalBytes > maxRequestBytes;
				tierMaxBytes = Math.floor(tierMaxBytes / 2)
			) {
				if (tierMaxBytes >= maxRequestBytes) continue;
				for (const slot of activeImages) {
					if (totalBytes <= maxRequestBytes) break;
					if (slot.dropped || slot.exhausted || slot.currentPart.type !== "image") continue;
					if (slot.currentPart.data.length <= tierMaxBytes) continue;
					throwIfAborted(signal);
					const resized = await resizeCached(cache, slot.sourceData, slot.sourceMimeType, {
						...limits.resizeOptions,
						maxBytes: tierMaxBytes,
					});
					if (!resized) {
						slot.exhausted = true;
						continue;
					}
					const delta = applyResizedSlot(slot, resized);
					if (delta < 0) {
						totalBytes += delta;
						changed = true;
					}
				}
			}

			// Phase 5: last-resort oldest-first omission if images still cannot fit inside maxRequestBytes.
			for (const slot of slots) {
				if (totalBytes <= maxRequestBytes) break;
				if (slot.dropped) continue;
				totalBytes += dropSlot(slot, OMITTED_REQUEST_BYTES_TEXT);
				changed = true;
			}
		}
	}

	if (!changed) return context;
	const nextMessages = buildUpdatedMessages(context.messages, slots);
	return { ...context, messages: nextMessages };
}
