import { describe, expect, it, vi } from "vitest";
import { classify, GEMINI_DECISION_1_MODEL } from "../src/api/google-decisions.ts";
import type { ClassifierContext, ImageContent } from "../src/types.ts";

const model = GEMINI_DECISION_1_MODEL;

const context: ClassifierContext = {
	state: { diff: "+const cache = new Map();" },
	questions: {
		category: {
			type: "choice",
			instructions: "Classify the change",
			criteria: { cache: "Caching logic", schema: "" },
		},
		quality: {
			type: "score",
			instructions: "Rate adherence",
			criteria: ["poor", "ok", "good"],
		},
		primitive_violation: {
			type: "bool",
			instructions: "Did the diff introduce a custom statement cache instead of DatabaseSync.createTagStore?",
			criteria: { true: "Added custom cache", false: "Used native tag store" },
		},
	},
};

/** Response shape verified against live `POST /v1beta/decisions` (`gemini-decision-1`) calls. */
const wireAnswers = {
	primitive_violation: {
		confidence: 0.8641334687783415,
		noul: 0.8641334687783415,
		type: "noul",
	},
	quality: {
		confidence: 0.40548185733453834,
		score: 1.0091950615380632,
		probabilities: { "1": 0.40548185733453834, "0": 0.29266154056369914, "2": 0.30185660210176246 },
		legend: { "1": "ok", "0": "poor", "2": "good" },
		type: "score",
	},
	category: {
		confidence: 0.9966809172497584,
		choice: "cache",
		probabilities: { cache: 0.9966809172497584, schema: 0.003319082750241533 },
		type: "choice",
	},
};

const wireUsage = {
	total_tokens: 230,
	total_input_tokens: 230,
	input_tokens_by_modality: [{ modality: "text", tokens: 230 }],
	total_output_tokens: 0,
};

const image: ImageContent = { type: "image", data: "aW1hZ2U=", mimeType: "image/png" };

describe("Google Decisions", () => {
	it("maps questions to Gemini Decisions types, authenticates with x-goog-api-key, and prices usage", async () => {
		const fetch = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
			Response.json({ answers: wireAnswers, usage: wireUsage }),
		);

		const result = await classify(model, context, { apiKey: "secret", fetch });

		expect(fetch).toHaveBeenCalledOnce();
		const [url, init] = fetch.mock.calls[0]!;
		expect(String(url)).toBe("https://generativelanguage.googleapis.com/v1beta/decisions");
		const headers = new Headers(init?.headers);
		expect(headers.get("x-goog-api-key")).toBe("secret");
		expect(headers.get("authorization")).toBeNull();
		expect(JSON.parse(String(init?.body))).toEqual({
			model: "gemini-decision-1",
			input: JSON.stringify(context.state),
			questions: {
				category: {
					type: "choice",
					instructions: "Classify the change",
					criteria: { cache: "Caching logic", schema: "" },
				},
				quality: {
					type: "score",
					instructions: "Rate adherence",
					criteria: ["poor", "ok", "good"],
				},
				primitive_violation: {
					type: "noul",
					instructions: "Did the diff introduce a custom statement cache instead of DatabaseSync.createTagStore?",
					criteria: {
						true_description: "Added custom cache",
						false_description: "Used native tag store",
					},
				},
			},
		});
		expect(result.stopReason).toBe("stop");
		expect(result.answers).toEqual({
			category: {
				type: "choice",
				choice: "cache",
				probabilities: { cache: 0.9966809172497584, schema: 0.003319082750241533 },
				confidence: 0.9966809172497584,
			},
			quality: {
				type: "score",
				score: 1.0091950615380632,
				confidence: 0.40548185733453834,
			},
			primitive_violation: {
				type: "bool",
				probability: 0.8641334687783415,
			},
		});
		expect(result.usage).toMatchObject({ input: 230, output: 0, cacheRead: 0, totalTokens: 230 });
		expect(result.usage?.cost.total).toBeCloseTo(0.000023, 12);
	});

	it("sends multimodal images as base64 parts after the JSON text state", async () => {
		const fetch = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
			Response.json({
				answers: wireAnswers,
				usage: {
					total_tokens: 1184,
					total_input_tokens: 1184,
					input_tokens_by_modality: [
						{ modality: "text", tokens: 95 },
						{ modality: "image", tokens: 1089 },
					],
					total_output_tokens: 0,
				},
			}),
		);

		const result = await classify(
			model,
			{ ...context, images: [image, { ...image, mimeType: "image/jpeg" }] },
			{ apiKey: "secret", fetch },
		);

		expect(result.stopReason).toBe("stop");
		expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body)).input).toEqual([
			{ type: "text", text: JSON.stringify(context.state) },
			{ type: "image", data: "aW1hZ2U=", mime_type: "image/png" },
			{ type: "image", data: "aW1hZ2U=", mime_type: "image/jpeg" },
		]);
		expect(result.usage?.totalTokens).toBe(1184);
	});

	it("maps non-conforming or prototype-sensitive question IDs to safe wire keys and restores them", async () => {
		const specialContext: ClassifierContext = {
			state: {},
			questions: JSON.parse(
				'{"__proto__":{"type":"bool","instructions":"Is this true?","criteria":{"true":"","false":""}},"has spaces?":{"type":"bool","instructions":"Has spaces?","criteria":{"true":"Yes","false":""}},"q_0":{"type":"bool","instructions":"Existing q_0","criteria":{"true":"","false":""}}}',
			),
		};
		const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
			const sent = JSON.parse(String(init?.body)) as { questions: Record<string, unknown> };
			return Response.json({
				answers: Object.fromEntries(
					Object.keys(sent.questions).map((key, index) => [
						key,
						{ type: "noul", noul: 0.25 * (index + 1), confidence: 0.8 },
					]),
				),
			});
		});

		const result = await classify(model, specialContext, { apiKey: "secret", fetch });

		const sentKeys = Object.keys(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body)).questions);
		expect(sentKeys).toEqual(["q_1", "q_2", "q_0"]);
		expect(result.stopReason).toBe("stop");
		expect(Object.hasOwn(result.answers, "__proto__")).toBe(true);
		expect(result.answers.__proto__).toEqual({ type: "bool", probability: 0.25 });
		expect(result.answers["has spaces?"]).toEqual({ type: "bool", probability: 0.5 });
		expect(result.answers.q_0).toEqual({ type: "bool", probability: 0.75 });
	});

	it("fails when a question is refused or missing and retains billed usage", async () => {
		const refused = await classify(model, context, {
			apiKey: "secret",
			fetch: async () =>
				Response.json({
					answers: { ...wireAnswers, primitive_violation: { type: "refusal" } },
					usage: wireUsage,
				}),
		});
		const missing = await classify(model, context, {
			apiKey: "secret",
			fetch: async () =>
				Response.json({
					answers: { category: wireAnswers.category, quality: wireAnswers.quality },
				}),
		});

		expect(refused.stopReason).toBe("error");
		expect(refused.answers).toEqual({});
		expect(refused.errorMessage).toBe("Google Decisions refused to answer primitive_violation");
		expect(refused.usage).toMatchObject({ input: 230 });
		expect(missing.stopReason).toBe("error");
		expect(missing.errorMessage).toContain("did not return an answer for primitive_violation");
	});

	it("rejects models for other classifier APIs, missing API keys, and excessive image counts", async () => {
		const fetch = vi.fn(async () => Response.json({ answers: wireAnswers }));
		const otherApi = await classify({ ...model, api: "openai-decisions" }, context, { apiKey: "secret", fetch });
		const noKey = await classify(model, context, { fetch });
		const tooManyImages = await classify(
			model,
			{ ...context, images: Array.from({ length: 3601 }, () => image) },
			{ apiKey: "secret", fetch },
		);

		expect(fetch).not.toHaveBeenCalled();
		expect(otherApi.errorMessage).toContain("Unsupported classifier API: openai-decisions");
		expect(noKey.errorMessage).toContain("No API key for provider: google");
		expect(tooManyImages.errorMessage).toContain("at most 3600 images, got 3601");
	});
});
