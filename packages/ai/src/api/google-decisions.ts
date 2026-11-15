import type {
	ClassifierAnswer,
	ClassifierContext,
	ClassifierFunction,
	ClassifierOptions,
	ClassifierQuestion,
	ClassifierResult,
} from "../types.ts";
import { formatProviderError, normalizeProviderError } from "../utils/error-body.ts";
import { isRecord, parseClassifierUsage, postClassifierRequest, requiredNumber } from "./classifier-shared.ts";
import { GEMINI_DECISION_1_MODEL, withGoogleDecisionsModels } from "./google-decisions-catalog.ts";

export { GEMINI_DECISION_1_MODEL, withGoogleDecisionsModels };

/**
 * Google's Gemini Decisions API: `POST /v1beta/decisions` with `{ model, input, questions }`.
 * https://ai.google.dev/gemini-api/docs/decisions
 *
 * The state is sent as JSON text. With images, the input becomes an array of content parts:
 * `{ type: "text", text }` followed by `{ type: "image", data, mime_type }`.
 * Questions map to Decisions types: `choice` to `choice`, `score` to `score`, and `bool` to
 * `noul` (`true_description` / `false_description`). Wire question keys must match
 * `[A-Za-z0-9_-]{1,64}`, so arbitrary caller question IDs are mapped to safe wire keys when
 * needed and restored in `result.answers`.
 */

const LABEL = "Google Decisions";
const SAFE_WIRE_KEY_RE = /^[A-Za-z0-9_-]{1,64}$/u;
const RESERVED_OBJECT_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** Gemini API inline image limit per request (matches `catalog/providers/google.ts`). */
const MAX_IMAGES = 3600;

type GoogleDecisionQuestion =
	| {
			type: "noul";
			instructions: string;
			criteria?: { true_description?: string; false_description?: string };
	  }
	| {
			type: "choice";
			instructions: string;
			criteria: Record<string, string>;
	  }
	| {
			type: "score";
			instructions: string;
			criteria: string[];
	  };

function wireQuestion(question: ClassifierQuestion): GoogleDecisionQuestion {
	if (question.type === "choice") {
		return {
			type: "choice",
			instructions: question.instructions,
			criteria: question.criteria,
		};
	}
	if (question.type === "score") {
		return {
			type: "score",
			instructions: question.instructions,
			criteria: question.criteria,
		};
	}
	const criteria: { true_description?: string; false_description?: string } = {};
	if (question.criteria.true) criteria.true_description = question.criteria.true;
	if (question.criteria.false) criteria.false_description = question.criteria.false;
	return Object.keys(criteria).length > 0
		? { type: "noul", instructions: question.instructions, criteria }
		: { type: "noul", instructions: question.instructions };
}

function wireQuestions(questions: Record<string, ClassifierQuestion>): {
	payload: Record<string, GoogleDecisionQuestion>;
	keyMap: Array<{ callerId: string; wireKey: string; question: ClassifierQuestion }>;
} {
	const entries = Object.entries(questions);
	const used = new Set<string>();
	const payload: Record<string, GoogleDecisionQuestion> = {};
	const keyMap: Array<{ callerId: string; wireKey: string; question: ClassifierQuestion }> = [];

	for (const [callerId] of entries) {
		if (SAFE_WIRE_KEY_RE.test(callerId) && !RESERVED_OBJECT_KEYS.has(callerId)) {
			used.add(callerId);
		}
	}

	let fallbackIndex = 0;
	const assigned = new Set<string>();
	for (const [callerId, question] of entries) {
		let wireKey = callerId;
		if (!SAFE_WIRE_KEY_RE.test(wireKey) || RESERVED_OBJECT_KEYS.has(wireKey) || assigned.has(wireKey)) {
			while (used.has(`q_${fallbackIndex}`) || assigned.has(`q_${fallbackIndex}`)) fallbackIndex++;
			wireKey = `q_${fallbackIndex++}`;
		}
		assigned.add(wireKey);
		payload[wireKey] = wireQuestion(question);
		keyMap.push({ callerId, wireKey, question });
	}

	return { payload, keyMap };
}

function wireInput(context: ClassifierContext): unknown {
	const state = JSON.stringify(context.state);
	const images = context.images ?? [];
	if (images.length === 0) return state;
	if (images.length > MAX_IMAGES) {
		throw new Error(`${LABEL} accepts at most ${MAX_IMAGES} images, got ${images.length}`);
	}
	return [
		{ type: "text", text: state },
		...images.map((image) => ({
			type: "image",
			data: image.data,
			mime_type: image.mimeType,
		})),
	];
}

function choiceProbabilities(value: unknown, id: string): Record<string, number> {
	if (!isRecord(value)) throw new Error(`${LABEL} returned invalid probabilities for ${id}`);
	return Object.fromEntries(
		Object.entries(value).map(([choice, probability]) => [
			choice,
			requiredNumber(LABEL, probability, `probability for ${id}.${choice}`),
		]),
	);
}

function parseAnswer(id: string, question: ClassifierQuestion, answer: Record<string, unknown>): ClassifierAnswer {
	if (answer.type === "refusal") throw new Error(`${LABEL} refused to answer ${id}`);
	if (question.type === "choice") {
		if (answer.type !== "choice" || typeof answer.choice !== "string") {
			throw new Error(`${LABEL} did not return a choice answer for ${id}`);
		}
		return {
			type: "choice",
			choice: answer.choice,
			probabilities: choiceProbabilities(answer.probabilities, id),
			confidence: requiredNumber(LABEL, answer.confidence, `confidence for ${id}`),
		};
	}
	if (question.type === "score") {
		if (answer.type !== "score") throw new Error(`${LABEL} did not return a score answer for ${id}`);
		return {
			type: "score",
			score: requiredNumber(LABEL, answer.score, `score for ${id}`),
			confidence: requiredNumber(LABEL, answer.confidence, `confidence for ${id}`),
		};
	}
	if (answer.type !== "noul") throw new Error(`${LABEL} did not return a noul answer for ${id}`);
	return { type: "bool", probability: requiredNumber(LABEL, answer.noul, `probability for ${id}`) };
}

function parseAnswers(
	value: unknown,
	keyMap: ReadonlyArray<{ callerId: string; wireKey: string; question: ClassifierQuestion }>,
): Record<string, ClassifierAnswer> {
	if (!isRecord(value)) throw new Error(`${LABEL} returned an unexpected response`);
	return Object.fromEntries(
		keyMap.map(({ callerId, wireKey, question }) => {
			const answer = Object.hasOwn(value, wireKey) ? value[wireKey] : undefined;
			if (!isRecord(answer)) throw new Error(`${LABEL} did not return an answer for ${callerId}`);
			return [callerId, parseAnswer(callerId, question, answer)];
		}),
	);
}

/** Classification through Google's Gemini Decisions API. */
export const classify: ClassifierFunction<ClassifierOptions> = async (model, context, options) => {
	const output: ClassifierResult = {
		api: model.api,
		provider: model.provider,
		model: model.id,
		answers: {},
		stopReason: "stop",
		timestamp: Date.now(),
	};

	try {
		if (model.api !== "google-decisions") throw new Error(`Unsupported classifier API: ${model.api}`);
		if (!options?.apiKey) throw new Error(`No API key for provider: ${model.provider}`);
		const { payload: questions, keyMap } = wireQuestions(context.questions);
		const body = await postClassifierRequest(
			LABEL,
			new URL("decisions", `${model.baseUrl.replace(/\/+$/u, "")}/`),
			model,
			{
				model: model.id,
				input: wireInput(context),
				questions,
			},
			options,
			undefined,
			{ "x-goog-api-key": options.apiKey },
		);
		if (!isRecord(body)) throw new Error(`${LABEL} returned an unexpected response`);
		// Set before parsing answers: a request with malformed or refused answers was still billed.
		const usage = parseClassifierUsage(body.usage, model);
		if (usage) output.usage = usage;
		output.answers = parseAnswers(body.answers, keyMap);
		return output;
	} catch (error) {
		output.answers = {};
		output.stopReason = options?.signal?.aborted ? "aborted" : "error";
		output.errorMessage = formatProviderError(normalizeProviderError(error), `${LABEL} error`);
		return output;
	}
};
