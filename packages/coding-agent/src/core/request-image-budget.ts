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
import { formatDimensionNote, type ImageResizeOptions, type ResizedImage, resizeImage } from "../utils/image-resize.ts";

const CLOUDFLARE_AI_GATEWAY_HOST = "gateway.ai.cloudflare.com";

/**
 * Conservative request byte ceiling for Cloudflare AI Gateway passthrough routes.
 * Cloudflare Workers isolates have a 128 MiB memory limit; measured live on the WorkOS
 * gateway (`google-ai-studio`), 27–37 MiB requests succeeded while 46–60 MiB streaming
 * requests evicted isolates mid-stream without logging.
 */
export const CLOUDFLARE_AI_GATEWAY_MAX_REQUEST_BYTES = 32 * 1024 * 1024;

/** Reserve headroom for provider-specific wire framing/escaping beyond TranscriptContext JSON. */
const WIRE_FRAMING_RESERVE_RATIO = 0.05;
const MAX_WIRE_FRAMING_RESERVE_BYTES = 2 * 1024 * 1024;
const DEFAULT_CACHE_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_GENTLE_MAX_BYTES = 4.5 * 1024 * 1024;
const MIN_TARGET_IMAGE_BYTES = 16 * 1024;

/**
 * Fixed descending base64 byte tiers for tighter oldest-first passes when Phase 3 still exceeds
 * `byteBudget`. Because each tier is a fixed constant independent of whole-request excess, every
 * historical image maps to a stable cache key and stays byte-identical as later turns append.
 */
const TIGHTER_MAX_BYTES_TIERS = [
	1024 * 1024,
	512 * 1024,
	256 * 1024,
	128 * 1024,
	64 * 1024,
	32 * 1024,
	MIN_TARGET_IMAGE_BYTES,
] as const;

const OMITTED_PER_MESSAGE_TEXT = "[Image omitted: exceeds model per-message image limit.]";
const OMITTED_PER_REQUEST_TEXT = "[Image omitted: exceeds model per-request image limit.]";
const OMITTED_REQUEST_BYTES_TEXT = "[Image omitted: exceeds model request size limit.]";

export interface EffectiveImageRequestLimits {
	maxRequestBytes?: number;
	byteBudget?: number;
	maxImagesPerRequest?: number;
	maxImagesPerMessage?: number;
	resizeOptions?: ImageResizeOptions;
}

function isPositiveLimit(value: number | undefined): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 1;
}

export function isCloudflareAiGatewayUrl(baseUrl: string | undefined): boolean {
	if (!baseUrl) return false;
	try {
		return new URL(baseUrl).hostname.toLowerCase() === CLOUDFLARE_AI_GATEWAY_HOST;
	} catch {
		return false;
	}
}

export function resolveEffectiveImageRequestLimits(model: Model<Api>): EffectiveImageRequestLimits | undefined {
	if (!model.input.includes("image")) return undefined;

	const rawMaxBytes = isPositiveLimit(model.inputLimits?.maxRequestBytes)
		? Math.floor(model.inputLimits.maxRequestBytes)
		: undefined;
	const maxRequestBytes = isCloudflareAiGatewayUrl(model.baseUrl)
		? rawMaxBytes !== undefined
			? Math.min(rawMaxBytes, CLOUDFLARE_AI_GATEWAY_MAX_REQUEST_BYTES)
			: CLOUDFLARE_AI_GATEWAY_MAX_REQUEST_BYTES
		: rawMaxBytes;

	const maxImagesPerRequest = isPositiveLimit(model.inputLimits?.images?.maxPerRequest)
		? Math.floor(model.inputLimits.images.maxPerRequest)
		: undefined;
	const maxImagesPerMessage = isPositiveLimit(model.inputLimits?.images?.maxPerMessage)
		? Math.floor(model.inputLimits.images.maxPerMessage)
		: undefined;

	if (maxRequestBytes === undefined && maxImagesPerRequest === undefined && maxImagesPerMessage === undefined) {
		return undefined;
	}

	const reserve =
		maxRequestBytes !== undefined
			? Math.min(Math.floor(maxRequestBytes * WIRE_FRAMING_RESERVE_RATIO), MAX_WIRE_FRAMING_RESERVE_BYTES)
			: undefined;
	const byteBudget =
		maxRequestBytes !== undefined && reserve !== undefined ? Math.max(1, maxRequestBytes - reserve) : undefined;

	return {
		...(maxRequestBytes !== undefined ? { maxRequestBytes, byteBudget } : {}),
		...(maxImagesPerRequest !== undefined ? { maxImagesPerRequest } : {}),
		...(maxImagesPerMessage !== undefined ? { maxImagesPerMessage } : {}),
		...(model.inputLimits?.images?.resize ? { resizeOptions: model.inputLimits.images.resize } : {}),
	};
}

interface CacheEntry {
	result: ResizedImage | null;
	bytes: number;
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
export class RequestImageFitCache {
	private readonly entries = new Map<string, CacheEntry>();
	private totalBytes = 0;
	private readonly maxBytes: number;

	constructor(maxBytes: number = DEFAULT_CACHE_MAX_BYTES) {
		this.maxBytes = maxBytes;
	}

	clear(): void {
		this.entries.clear();
		this.totalBytes = 0;
	}

	async getOrResize(
		sourceData: string,
		sourceMimeType: string,
		options?: ImageResizeOptions,
	): Promise<ResizedImage | null> {
		const key = cacheKey(sourceData, sourceMimeType, options);
		const cached = this.entries.get(key);
		if (cached !== undefined) {
			// Refresh LRU recency.
			this.entries.delete(key);
			this.entries.set(key, cached);
			return cached.result;
		}

		const result = await resizeImage(Buffer.from(sourceData, "base64"), sourceMimeType, options).catch(() => null);
		const entryBytes = result ? result.data.length * 2 + 256 : 128;
		if (entryBytes <= this.maxBytes) {
			this.entries.set(key, { result, bytes: entryBytes });
			this.totalBytes += entryBytes;
			while (this.totalBytes > this.maxBytes) {
				const oldestKey = this.entries.keys().next().value;
				if (oldestKey === undefined) break;
				const oldest = this.entries.get(oldestKey);
				if (oldest) this.totalBytes -= oldest.bytes;
				this.entries.delete(oldestKey);
			}
		}
		return result;
	}
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

function roughWireUpperBoundBytes(messages: readonly Message[]): { imageBytes: number; roughTotal: number } {
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
	return { imageBytes, roughTotal: imageBytes + nonImageChars * 4 + messages.length * 128 };
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
 * plus Cloudflare AI Gateway's 32 MiB request ceiling on a projected transcript context without
 * mutating saved session history.
 *
 * When the request already fits within all active limits, returns `context` unchanged so images
 * remain at full resolution with zero resizing overhead. When a limit would be exceeded, shrinks
 * oldest images first via Pi's native `resizeImage()` so the most recent images stay full-size
 * whenever possible, omitting oldest images only as a last resort.
 */
export async function fitContextImagesToRequestLimit(
	model: Model<Api>,
	context: TranscriptContext,
	cache: RequestImageFitCache = new RequestImageFitCache(),
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
		if (limits.byteBudget === undefined) return context;
		const { roughTotal } = roughWireUpperBoundBytes(context.messages);
		if (roughTotal <= limits.byteBudget) return context;
	}

	// Exact wire-byte accounting only when near/above a limit.
	let totalBytes = 2; // JSON array framing
	for (const message of context.messages) {
		totalBytes += measureWireMessageBytes(message) + 1;
	}
	for (const slot of slots) {
		slot.currentBytes = slotSerializedBytes(slot.currentPart);
	}

	if (
		!exceedsPerMessage &&
		!exceedsPerRequest &&
		(limits.byteBudget === undefined || totalBytes <= limits.byteBudget)
	) {
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

	const byteBudget = limits.byteBudget;
	if (byteBudget !== undefined && totalBytes > byteBudget) {
		const omittedBytes = slotSerializedBytes({ type: "text", text: OMITTED_REQUEST_BYTES_TEXT });
		const activeImages = slots.filter((slot) => !slot.dropped);
		const nonImageBytes =
			totalBytes - activeImages.reduce((sum, slot) => sum + Math.max(0, slot.currentBytes - omittedBytes), 0);

		// Phase 2: if text/tool history alone exceeds the byte limit, image changes cannot make the request fit.
		if (nonImageBytes <= byteBudget) {
			// Phase 3: gentle oldest-first resize using model's resize profile (keeps newest screenshots full-size).
			// Cap maxBytes at this image's own source base64 length (intrinsic to the image, independent of
			// later turns for prompt-cache stability) so uncompressed PNGs within 2000x2000 still re-encode
			// to compact JPEG instead of short-circuiting unchanged.
			for (const slot of activeImages) {
				if (totalBytes <= byteBudget) break;
				throwIfAborted(signal);
				const configuredMaxBytes = limits.resizeOptions?.maxBytes ?? DEFAULT_GENTLE_MAX_BYTES;
				const gentleOptions: ImageResizeOptions = {
					...limits.resizeOptions,
					maxBytes: Math.min(configuredMaxBytes, Math.max(MIN_TARGET_IMAGE_BYTES, slot.sourceData.length)),
				};
				const resized = await cache.getOrResize(slot.sourceData, slot.sourceMimeType, gentleOptions);
				if (resized) {
					const delta = applyResizedSlot(slot, resized);
					if (delta < 0) {
						totalBytes += delta;
						changed = true;
					}
				}
			}

			// Phase 4: tighter proportional oldest-first resize from original bytes if still over budget.
			// Phase 4: tighter oldest-first resize through fixed descending byte tiers so each image's
			// resize options stay independent of request-wide excess (preserving cache hits and prompt prefixes).
			const configuredMaxBytes = limits.resizeOptions?.maxBytes ?? DEFAULT_GENTLE_MAX_BYTES;
			for (const tierMaxBytes of TIGHTER_MAX_BYTES_TIERS) {
				if (totalBytes <= byteBudget) break;
				const effectiveTierMaxBytes = Math.min(configuredMaxBytes, tierMaxBytes);
				for (const slot of activeImages) {
					if (totalBytes <= byteBudget) break;
					if (slot.dropped || slot.currentPart.type !== "image") continue;
					if (slot.currentPart.data.length <= effectiveTierMaxBytes) continue;
					throwIfAborted(signal);
					const resized = await cache.getOrResize(slot.sourceData, slot.sourceMimeType, {
						...limits.resizeOptions,
						maxBytes: effectiveTierMaxBytes,
					});
					if (resized) {
						const delta = applyResizedSlot(slot, resized);
						if (delta < 0) {
							totalBytes += delta;
							changed = true;
						}
					}
				}
			}

			// Phase 5: last-resort oldest-first omission if images still cannot fit inside byteBudget.
			for (const slot of slots) {
				if (totalBytes <= byteBudget) break;
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
