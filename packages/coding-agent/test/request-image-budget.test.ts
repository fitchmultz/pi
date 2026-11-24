import { deflateSync } from "node:zlib";
import {
	type Api,
	createAssistantMessageEventStream,
	createProvider,
	type ImageContent,
	type JsonObject,
	type Model,
	normalizeContext,
	type ToolResultMessage,
	type TranscriptContext,
	type UserMessage,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import {
	CLOUDFLARE_AI_GATEWAY_MAX_REQUEST_BYTES,
	fitContextImagesToRequestLimit,
	isCloudflareAiGatewayUrl,
	RequestImageFitCache,
	resolveEffectiveImageRequestLimits,
} from "../src/core/request-image-budget.ts";

/** Build a valid, noisy PNG of width×height with a deterministic seed so Photon decodes and compresses it cleanly. */
function makeNoisyPngBase64(width: number, height: number, seed: number): string {
	const crcTable = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		crcTable[n] = c >>> 0;
	}
	const crc32 = (buf: Uint8Array): number => {
		let c = 0xffffffff;
		for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
		return (c ^ 0xffffffff) >>> 0;
	};
	const chunk = (type: string, data: Uint8Array): Buffer => {
		const len = Buffer.alloc(4);
		len.writeUInt32BE(data.length, 0);
		const typeBytes = Buffer.from(type, "ascii");
		const payload = Buffer.concat([typeBytes, data]);
		const crc = Buffer.alloc(4);
		crc.writeUInt32BE(crc32(payload), 0);
		return Buffer.concat([len, payload, crc]);
	};

	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 2; // RGB
	ihdr[10] = 0;
	ihdr[11] = 0;
	ihdr[12] = 0;

	// Pseudo-random per-pixel gradient + noise so PNG compresses poorly while JPEG compresses strongly.
	const stride = 1 + width * 3;
	const raw = Buffer.alloc(stride * height);
	let state = (seed * 2654435761) >>> 0;
	for (let y = 0; y < height; y++) {
		const row = y * stride;
		raw[row] = 0;
		for (let x = 0; x < width; x++) {
			state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
			const offset = row + 1 + x * 3;
			raw[offset] = ((x * 7 + y * 3 + (state >>> 24)) & 0xff) >>> 0;
			raw[offset + 1] = ((x * 5 + y * 11 + ((state >>> 16) & 0xff)) & 0xff) >>> 0;
			raw[offset + 2] = ((x * 13 + y * 2 + ((state >>> 8) & 0xff)) & 0xff) >>> 0;
		}
	}

	const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
	const png = Buffer.concat([
		sig,
		chunk("IHDR", ihdr),
		chunk("IDAT", deflateSync(raw, { level: 1 })),
		chunk("IEND", Buffer.alloc(0)),
	]);
	return png.toString("base64");
}

function makeModel(overrides: Partial<Model<Api>> = {}): Model<Api> {
	return {
		id: "gemini-4-neon",
		name: "Gemini 4 Neon",
		api: "google-generative-ai",
		provider: "google",
		baseUrl: "https://generativelanguage.googleapis.com/v1beta",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 65_536,
		inputLimits: {
			maxRequestBytes: 100 * 1024 * 1024,
			images: { maxPerRequest: 3600 },
		},
		...overrides,
	};
}

function imagePart(data: string, mimeType = "image/png"): ImageContent {
	return { type: "image", data, mimeType };
}

function toolResultWithImage(id: string, data: string, details?: JsonObject): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: "read",
		isError: false,
		content: [{ type: "text", text: `Read ${id}` }, imagePart(data)],
		...(details ? { details } : {}),
		timestamp: Date.now(),
	};
}

describe("resolveEffectiveImageRequestLimits", () => {
	it("caps Cloudflare AI Gateway routes at 32 MiB while preserving smaller explicit overrides and direct Google 100 MiB", () => {
		expect(isCloudflareAiGatewayUrl("https://gateway.ai.cloudflare.com/v1/acc/workos/google-ai-studio/v1beta")).toBe(
			true,
		);
		expect(isCloudflareAiGatewayUrl("https://generativelanguage.googleapis.com/v1beta")).toBe(false);

		const directGoogle = resolveEffectiveImageRequestLimits(makeModel());
		expect(directGoogle?.maxRequestBytes).toBe(100 * 1024 * 1024);

		const cfGoogle = resolveEffectiveImageRequestLimits(
			makeModel({ baseUrl: "https://gateway.ai.cloudflare.com/v1/acc/workos/google-ai-studio/v1beta" }),
		);
		expect(cfGoogle?.maxRequestBytes).toBe(CLOUDFLARE_AI_GATEWAY_MAX_REQUEST_BYTES);

		const cfSmallerOverride = resolveEffectiveImageRequestLimits(
			makeModel({
				baseUrl: "https://gateway.ai.cloudflare.com/v1/acc/workos/google-ai-studio/v1beta",
				inputLimits: { maxRequestBytes: 16 * 1024 * 1024 },
			}),
		);
		expect(cfSmallerOverride?.maxRequestBytes).toBe(16 * 1024 * 1024);

		const textOnly = resolveEffectiveImageRequestLimits(makeModel({ input: ["text"] }));
		expect(textOnly).toBeUndefined();
	});
});

describe("fitContextImagesToRequestLimit", () => {
	const img1 = makeNoisyPngBase64(320, 200, 1);
	const img2 = makeNoisyPngBase64(320, 200, 2);
	const img3 = makeNoisyPngBase64(320, 200, 3);

	it("returns the exact same context untouched when request fits inside maxRequestBytes (even with large local toolResult details)", async () => {
		const model = makeModel({
			inputLimits: { maxRequestBytes: img1.length * 4, images: { maxPerRequest: 10 } },
		});
		const context = normalizeContext({
			messages: [
				toolResultWithImage("call_1", img1, { hugeLocalMetadata: "x".repeat(img1.length * 6) }),
				toolResultWithImage("call_2", img2),
			],
		});

		const fitted = await fitContextImagesToRequestLimit(model, context);
		expect(fitted).toBe(context);
	});

	it("shrinks oldest images first when over maxRequestBytes, keeping newest full-size untouched and never mutating saved history", async () => {
		// Three noisy 320x200 PNGs are ~240 KiB base64 each (~720 KiB total).
		// Set maxRequestBytes so 2 full-size + 1 shrunk fits (~560 KiB), forcing only the oldest image to shrink.
		const singleLen = img1.length;
		const model = makeModel({
			inputLimits: {
				maxRequestBytes: Math.floor(singleLen * 2.5),
				images: { maxPerRequest: 10, resize: { maxWidth: 200, maxHeight: 200, jpegQuality: 70 } },
			},
		});

		const originalMessages = [
			toolResultWithImage("call_1", img1),
			toolResultWithImage("call_2", img2),
			toolResultWithImage("call_3", img3),
		];
		const context = normalizeContext({ messages: originalMessages });
		const cache = new RequestImageFitCache();

		const fitted = await fitContextImagesToRequestLimit(model, context, cache);
		expect(fitted).not.toBe(context);

		const m0 = fitted.messages[0] as ToolResultMessage;
		const m1 = fitted.messages[1] as ToolResultMessage;
		const m2 = fitted.messages[2] as ToolResultMessage;

		const fittedImg0 = m0.content.find((p): p is ImageContent => p.type === "image");
		const fittedImg1 = m1.content.find((p): p is ImageContent => p.type === "image");
		const fittedImg2 = m2.content.find((p): p is ImageContent => p.type === "image");

		// Oldest image was resized and gained a dimension note; newest two stayed byte-identical full-size!
		expect(fittedImg0).toBeDefined();
		expect(fittedImg0!.data.length).toBeLessThan(img1.length);
		expect(m0.content.some((p) => p.type === "text" && p.text.includes("original 320x200"))).toBe(true);
		expect(fittedImg1?.data).toBe(img2);
		expect(fittedImg2?.data).toBe(img3);

		// Original saved history objects were never mutated.
		expect((originalMessages[0]!.content[1] as ImageContent).data).toBe(img1);

		// Second call with the same cache produces byte-identical output (prompt-cache prefix stability).
		const fittedAgain = await fitContextImagesToRequestLimit(model, context, cache);
		expect(fittedAgain.messages).toEqual(fitted.messages);
	});

	it("compresses uncompressed PNGs within 2000x2000 without downscaling or emitting a no-op dimension note, keeping prefix byte-identical as later turns append", async () => {
		const img4 = makeNoisyPngBase64(320, 200, 4);
		// Default resize options (2000x2000, 4.5 MiB) cover 320x200 PNGs; cap maxRequestBytes so oldest PNGs
		// re-encode to JPEG at native 320x200 while the newest screenshot stays untouched full-size PNG.
		const model = makeModel({
			inputLimits: {
				maxRequestBytes: Math.floor(img1.length * 2.8),
				images: { maxPerRequest: 10 },
			},
		});
		const cache = new RequestImageFitCache();

		const turn1 = normalizeContext({
			messages: [
				toolResultWithImage("call_1", img1),
				toolResultWithImage("call_2", img2),
				toolResultWithImage("call_3", img3),
			],
		});
		const fitted1 = await fitContextImagesToRequestLimit(model, turn1, cache);
		const m0Turn1 = fitted1.messages[0] as ToolResultMessage;
		const out0Turn1 = m0Turn1.content.find((p): p is ImageContent => p.type === "image");
		expect(out0Turn1?.mimeType).toBe("image/jpeg");
		expect(out0Turn1!.data.length).toBeLessThan(img1.length);
		// Dimensions stayed 320x200, so no redundant "Multiply x coordinates by 320/320" note is added.
		expect(m0Turn1.content.some((p) => p.type === "text" && p.text.includes("Multiply x coordinates"))).toBe(false);
		// Newest screenshot stayed full-size PNG untouched.
		expect((fitted1.messages[2] as ToolResultMessage).content.find((p) => p.type === "image")).toEqual(
			imagePart(img3),
		);

		// Appending a 4th screenshot keeps message 0 byte-identical for prompt-cache prefix reuse.
		const turn2 = normalizeContext({
			messages: [...turn1.messages, toolResultWithImage("call_4", img4)],
		});
		const fitted2 = await fitContextImagesToRequestLimit(model, turn2, cache);
		expect(fitted2.messages[0]).toEqual(fitted1.messages[0]);
		expect((fitted2.messages[3] as ToolResultMessage).content.find((p) => p.type === "image")).toEqual(
			imagePart(img4),
		);
	});

	it("enforces maxPerMessage and maxPerRequest by omitting oldest images while keeping newest", async () => {
		const model = makeModel({
			inputLimits: {
				maxRequestBytes: 100 * 1024 * 1024,
				images: { maxPerMessage: 2, maxPerRequest: 3 },
			},
		});
		const userMsg: UserMessage = {
			role: "user",
			content: [imagePart(img1), imagePart(img2), imagePart(img3)],
			timestamp: Date.now(),
		};
		const context = normalizeContext({
			messages: [toolResultWithImage("call_old", img1), toolResultWithImage("call_mid", img2), userMsg],
		});

		const fitted = await fitContextImagesToRequestLimit(model, context);

		// userMsg had 3 images > maxPerMessage(2), so its oldest (img1) dropped, leaving img2 & img3.
		const fittedUser = fitted.messages[2] as UserMessage;
		const userParts = fittedUser.content as Array<{ type: string; data?: string; text?: string }>;
		expect(userParts[0]).toEqual({ type: "text", text: "[Image omitted: exceeds model per-message image limit.]" });
		expect(userParts[1]?.data).toBe(img2);
		expect(userParts[2]?.data).toBe(img3);

		// Across the whole request, 4 remained (call_old, call_mid, img2, img3) > maxPerRequest(3), so call_old dropped.
		const fittedOld = fitted.messages[0] as ToolResultMessage;
		expect(fittedOld.content[1]).toEqual({
			type: "text",
			text: "[Image omitted: exceeds model per-request image limit.]",
		});
		// call_mid stayed intact.
		expect((fitted.messages[1] as ToolResultMessage).content[1]).toEqual(imagePart(img2));
	});

	it("does not resize or destroy images when text/tool history alone already exceeds maxRequestBytes", async () => {
		const model = makeModel({
			inputLimits: { maxRequestBytes: 5_000 },
		});
		const context = normalizeContext({
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: "a".repeat(10_000) }, imagePart(img1)],
					timestamp: Date.now(),
				},
			],
		});

		const fitted = await fitContextImagesToRequestLimit(model, context);
		expect(fitted).toBe(context);
	});

	it("falls back to omitting oldest images when even resized images cannot fit a tiny byte cap", async () => {
		const model = makeModel({
			inputLimits: { maxRequestBytes: 1_500 },
		});
		const context = normalizeContext({
			messages: [toolResultWithImage("call_1", img1), toolResultWithImage("call_2", img2)],
		});

		const fitted = await fitContextImagesToRequestLimit(model, context);
		const m0 = fitted.messages[0] as ToolResultMessage;
		const m1 = fitted.messages[1] as ToolResultMessage;
		expect(m0.content[1]).toEqual({ type: "text", text: "[Image omitted: exceeds model request size limit.]" });
		expect(m1.content[1]).toEqual({ type: "text", text: "[Image omitted: exceeds model request size limit.]" });
	});

	it("aborts immediately before resizing when AbortSignal is already aborted", async () => {
		const model = makeModel({
			inputLimits: { maxRequestBytes: Math.floor(img1.length * 1.2) },
		});
		const context = normalizeContext({
			messages: [toolResultWithImage("call_1", img1), toolResultWithImage("call_2", img2)],
		});
		const controller = new AbortController();
		controller.abort();

		await expect(fitContextImagesToRequestLimit(model, context, undefined, controller.signal)).rejects.toThrow(
			"Request aborted",
		);
	});

	it("applies fixed-tier tighter resize when gentle resize alone still exceeds maxRequestBytes and keeps earlier images byte-identical as later turns append", async () => {
		const img4 = makeNoisyPngBase64(320, 200, 4);
		// Two 320x200 noisy PNGs compress to ~115 KiB JPEG each after gentle resize (~230 KiB total).
		// Cap maxRequestBytes at 205 KiB so Phase 3 alone is insufficient and Phase 4 steps message 0
		// down to a fixed byte tier (64 KiB). Appending a third image keeps message 0 byte-identical.
		const model = makeModel({
			inputLimits: {
				maxRequestBytes: 205 * 1024,
				images: { maxPerRequest: 10 },
			},
		});
		const cache = new RequestImageFitCache();
		const turn1 = normalizeContext({
			messages: [toolResultWithImage("call_1", img1), toolResultWithImage("call_2", img2)],
		});

		const fitted1 = await fitContextImagesToRequestLimit(model, turn1, cache);
		const parts0 = (fitted1.messages[0] as ToolResultMessage).content;
		const parts1 = (fitted1.messages[1] as ToolResultMessage).content;
		const out0 = parts0.find((p): p is ImageContent => p.type === "image");
		const out1 = parts1.find((p): p is ImageContent => p.type === "image");

		expect(out0).toBeDefined();
		expect(out1).toBeDefined();
		expect(out0!.data.length).toBeLessThanOrEqual(64 * 1024);
		expect(Buffer.byteLength(JSON.stringify(fitted1.messages), "utf8")).toBeLessThanOrEqual(205 * 1024);

		// Appending a 3rd image enters Phase 4 again; message 0 must reuse the exact same fixed-tier encoding.
		const turn2 = normalizeContext({
			messages: [...turn1.messages, toolResultWithImage("call_4", img4)],
		});
		const fitted2 = await fitContextImagesToRequestLimit(model, turn2, cache);
		expect(fitted2.messages[0]).toEqual(fitted1.messages[0]);
		expect(Buffer.byteLength(JSON.stringify(fitted2.messages), "utf8")).toBeLessThanOrEqual(205 * 1024);
	});

	it("integrates into ModelRuntime.streamSimple and ModelRuntime.stream so providers receive the fitted context", async () => {
		const receivedContexts: TranscriptContext[] = [];
		const model = makeModel({
			id: "budget-test-model",
			provider: "budget-test",
			inputLimits: {
				maxRequestBytes: Math.floor(img1.length * 2.5),
				images: { maxPerRequest: 10, resize: { maxWidth: 200, maxHeight: 200, jpegQuality: 70 } },
			},
		});

		const emitOk = (streamModel: Model<Api>, context: TranscriptContext) => {
			receivedContexts.push(context);
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				stream.push({
					type: "done",
					reason: "stop",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "ok" }],
						api: streamModel.api,
						provider: streamModel.provider,
						model: streamModel.id,
						usage: {
							input: 10,
							output: 1,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 11,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "stop",
						timestamp: Date.now(),
					},
				});
				stream.end();
			});
			return stream;
		};

		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory({ "budget-test": { type: "api_key", key: "test-key" } }),
			modelsPath: null,
		});
		runtime.registerNativeProvider(
			createProvider({
				id: "budget-test",
				auth: { apiKey: { name: "Budget Test Key", resolve: async () => ({ auth: {} }) } },
				models: [model],
				api: {
					stream: emitOk,
					streamSimple: emitOk,
				},
			}),
		);

		const runtimeModel = runtime.getModel("budget-test", "budget-test-model");
		expect(runtimeModel).toBeDefined();

		const context = {
			messages: [
				toolResultWithImage("call_1", img1),
				toolResultWithImage("call_2", img2),
				toolResultWithImage("call_3", img3),
			],
		};

		const simpleResult = await runtime.completeSimple(runtimeModel!, context);
		expect(simpleResult.stopReason).toBe("stop");

		const streamResult = await runtime.complete(runtimeModel!, context);
		expect(streamResult.stopReason).toBe("stop");

		expect(receivedContexts).toHaveLength(2);
		expect(receivedContexts[0]!.messages).toEqual(receivedContexts[1]!.messages);

		const sent0 = (receivedContexts[0]!.messages[0] as ToolResultMessage).content.find(
			(p): p is ImageContent => p.type === "image",
		);
		const sent2 = (receivedContexts[0]!.messages[2] as ToolResultMessage).content.find(
			(p): p is ImageContent => p.type === "image",
		);
		expect(sent0!.data.length).toBeLessThan(img1.length);
		expect(sent2!.data).toBe(img3);
	});
});
