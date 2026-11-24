import { describe, expect, it } from "vitest";
import { GOOGLE_IMAGE_CATALOG_MODELS, generateImages } from "../src/api/google-images.ts";
import { builtinModels } from "../src/providers/all.ts";
import type { ImageModel } from "../src/types.ts";

const NANO_BANANA_2_1: ImageModel<"google-images"> = GOOGLE_IMAGE_CATALOG_MODELS.find(
	(model) => model.id === "gemini-nano-banana-2.1",
)!;

describe("google-images", () => {
	it("registers native Nano Banana models on the built-in google provider", () => {
		const models = builtinModels();
		const googleImages = models.getModelsOfType("image", "google");
		const ids = googleImages.map((model) => model.id);
		expect(ids).toContain("gemini-nano-banana-2.1");
		expect(ids).toContain("gemini-3.1-flash-image");
		expect(ids).toContain("gemini-3.1-flash-lite-image");
		expect(ids).toContain("gemini-3-pro-image");
		expect(ids).toContain("gemini-2.5-flash-image");
		expect(models.getModelOfType("image", "google", "gemini-nano-banana-2.1")?.api).toBe("google-images");
	});

	it("sends generateContent with text/image parts, responseModalities, imageConfig, and filters thought parts", async () => {
		const requests: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
		const fakeFetch: typeof fetch = async (input, init) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
			const bodyText =
				typeof init?.body === "string" ? init.body : input instanceof Request ? await input.clone().text() : "";
			requests.push({ url, headers, body: JSON.parse(bodyText) as Record<string, unknown> });
			return new Response(
				JSON.stringify({
					responseId: "resp-img-1",
					candidates: [
						{
							finishReason: "STOP",
							content: {
								role: "model",
								parts: [
									{ thought: true, text: "Internal composition plan..." },
									{
										thought: true,
										inlineData: { mimeType: "image/png", data: "dGhvdWdodC1kcmFmdA==" },
									},
									{ text: "Here is your fox." },
									{ inlineData: { mimeType: "image/png", data: "ZmluYWwtcG5nLWJ5dGVz" } },
								],
							},
						},
					],
					usageMetadata: {
						promptTokenCount: 100,
						cachedContentTokenCount: 20,
						candidatesTokenCount: 1200,
						thoughtsTokenCount: 300,
						totalTokenCount: 1600,
					},
				}),
				{ status: 200, headers: { "content-type": "application/json", "x-test-header": "ok" } },
			);
		};

		let observedResponseStatus: number | undefined;
		const result = await generateImages(
			NANO_BANANA_2_1,
			{
				input: [
					{ type: "text", text: "A red fox in the snow" },
					{ type: "image", mimeType: "image/jpeg", data: "cmVmLWltYWdl" },
				],
			},
			{
				apiKey: "test-gemini-key",
				aspectRatio: "16:9",
				imageSize: "2K",
				fetch: fakeFetch,
				onResponse: (response) => {
					observedResponseStatus = response.status;
				},
			},
		);

		expect(result.stopReason).toBe("stop");
		expect(result.responseId).toBe("resp-img-1");
		expect(observedResponseStatus).toBe(200);
		expect(result.output).toEqual([
			{ type: "text", text: "Here is your fox." },
			{ type: "image", mimeType: "image/png", data: "ZmluYWwtcG5nLWJ5dGVz" },
		]);
		expect(result.usage).toMatchObject({
			input: 80,
			cacheRead: 20,
			output: 1500,
			reasoning: 300,
			totalTokens: 1600,
		});
		expect(result.usage!.cost.total).toBeGreaterThan(0);

		expect(requests).toHaveLength(1);
		expect(requests[0]!.url).toContain("/models/gemini-nano-banana-2.1:generateContent");
		expect(requests[0]!.headers.get("x-goog-api-key")).toBe("test-gemini-key");
		expect(requests[0]!.body).toMatchObject({
			contents: [
				{
					role: "user",
					parts: [
						{ text: "A red fox in the snow" },
						{ inlineData: { mimeType: "image/jpeg", data: "cmVmLWltYWdl" } },
					],
				},
			],
			generationConfig: {
				responseModalities: ["TEXT", "IMAGE"],
				imageConfig: { aspectRatio: "16:9", imageSize: "2K" },
			},
		});
	});

	it("authenticates Cloudflare AI Gateway /google-ai-studio passthroughs using cf-aig-authorization", async () => {
		const seenHeaders: Headers[] = [];
		const gatewayModel: ImageModel<"google-images"> = {
			...NANO_BANANA_2_1,
			baseUrl: "https://gateway.ai.cloudflare.com/v1/acct-1/gw-1/google-ai-studio/v1beta",
			headers: { "cf-aig-authorization": "Bearer cf-aig-token-123" },
		};

		const result = await generateImages(
			gatewayModel,
			{ input: [{ type: "text", text: "A blue square" }] },
			{
				fetch: async (input, init) => {
					seenHeaders.push(new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)));
					return new Response(
						JSON.stringify({
							candidates: [
								{
									finishReason: "STOP",
									content: {
										role: "model",
										parts: [{ inlineData: { mimeType: "image/png", data: "aW1hZ2U=" } }],
									},
								},
							],
						}),
						{ status: 200, headers: { "content-type": "application/json" } },
					);
				},
			},
		);

		expect(result.stopReason).toBe("stop");
		expect(result.output).toEqual([{ type: "image", mimeType: "image/png", data: "aW1hZ2U=" }]);
		expect(seenHeaders).toHaveLength(1);
		expect(seenHeaders[0]!.get("cf-aig-authorization")).toBe("Bearer cf-aig-token-123");
		expect(seenHeaders[0]!.get("x-goog-api-key")).toBe("cf-aig-token-123");
	});

	it("returns stopReason error on promptFeedback blockReason and non-STOP finishReason", async () => {
		const blocked = await generateImages(
			NANO_BANANA_2_1,
			{ input: [{ type: "text", text: "blocked prompt" }] },
			{
				apiKey: "test-key",
				fetch: async () =>
					new Response(
						JSON.stringify({
							promptFeedback: { blockReason: "SAFETY", blockReasonMessage: "Blocked by safety filter" },
						}),
						{ status: 200, headers: { "content-type": "application/json" } },
					),
			},
		);
		expect(blocked.stopReason).toBe("error");
		expect(blocked.errorMessage).toContain("Prompt blocked (SAFETY): Blocked by safety filter");

		const safetyFinish = await generateImages(
			NANO_BANANA_2_1,
			{ input: [{ type: "text", text: "unsafe image" }] },
			{
				apiKey: "test-key",
				fetch: async () =>
					new Response(
						JSON.stringify({
							candidates: [{ finishReason: "IMAGE_SAFETY", content: { role: "model", parts: [] } }],
						}),
						{ status: 200, headers: { "content-type": "application/json" } },
					),
			},
		);
		expect(safetyFinish.stopReason).toBe("error");
		expect(safetyFinish.errorMessage).toContain("IMAGE_SAFETY");
	});

	it("returns stopReason error when no API key or gateway token is available", async () => {
		const result = await generateImages(NANO_BANANA_2_1, { input: [{ type: "text", text: "test" }] });
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("No API key for provider: google");
	});
});
