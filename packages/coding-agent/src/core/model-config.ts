/** Immutable, credential-blind models.json snapshot. */

import { readFile } from "node:fs/promises";
import { ProviderCompatSchema } from "@earendil-works/pi-ai/providers/compat-schema";
import {
	ModelCostSchema,
	ModelInputLimitsSchema,
	ModelInputModalitySchema,
	ModelPromptCacheSchema,
	ThinkingLevelMapSchema,
} from "@earendil-works/pi-ai/providers/model-schema";
import { type Static, Type } from "typebox";
import { Compile } from "typebox/compile";
import type { TLocalizedValidationError } from "typebox/error";
import { stripJsonComments } from "../utils/json.ts";
import { normalizePath } from "../utils/paths.ts";
import { stripBom } from "../utils/text.ts";

const SamplingParamsSchema = Type.Record(Type.String(), Type.Unknown());
const SamplingParamsByThinkingLevelSchema = Type.Object(
	{
		off: Type.Optional(SamplingParamsSchema),
		minimal: Type.Optional(SamplingParamsSchema),
		low: Type.Optional(SamplingParamsSchema),
		medium: Type.Optional(SamplingParamsSchema),
		high: Type.Optional(SamplingParamsSchema),
		xhigh: Type.Optional(SamplingParamsSchema),
		max: Type.Optional(SamplingParamsSchema),
	},
	{ description: "samplingParams per thinking level, merged over samplingParams." },
);

const SamplingParamsFieldSchema = Type.Record(Type.String(), Type.Unknown(), {
	description: "Fields merged into every request body. Applies only to OpenAI-compatible APIs.",
});
const HeadersSchema = Type.Record(Type.String(), Type.String(), {
	description: "Request headers. Values resolve like apiKey.",
});

/** Model fields shared by models entries and modelOverrides entries. Defaults apply only to models entries. */
const ModelFieldDescriptions = {
	name: "Display name, also matched by --model patterns.",
	reasoning: "Whether the model supports thinking.",
	contextWindow: "Context window in tokens.",
	maxTokens: "Maximum output tokens.",
} as const;

const ModelDefinitionSchema = Type.Object({
	id: Type.String({ minLength: 1, description: "Model ID sent to the API." }),
	name: Type.Optional(Type.String({ minLength: 1, description: ModelFieldDescriptions.name })),
	api: Type.Optional(Type.String({ minLength: 1, description: "Overrides the provider api." })),
	baseUrl: Type.Optional(Type.String({ minLength: 1, description: "Overrides the provider baseUrl." })),
	reasoning: Type.Optional(Type.Boolean({ default: false, description: ModelFieldDescriptions.reasoning })),
	thinkingLevelMap: Type.Optional(ThinkingLevelMapSchema),
	input: Type.Optional(Type.Array(ModelInputModalitySchema, { default: ["text"] })),
	inputLimits: Type.Optional(ModelInputLimitsSchema),
	cost: Type.Optional(ModelCostSchema),
	promptCache: Type.Optional(ModelPromptCacheSchema),
	contextWindow: Type.Optional(
		Type.Number({ exclusiveMinimum: 0, default: 128000, description: ModelFieldDescriptions.contextWindow }),
	),
	maxTokens: Type.Optional(
		Type.Number({ exclusiveMinimum: 0, default: 16384, description: ModelFieldDescriptions.maxTokens }),
	),
	samplingParams: Type.Optional(SamplingParamsFieldSchema),
	samplingParamsByThinkingLevel: Type.Optional(SamplingParamsByThinkingLevelSchema),
	headers: Type.Optional(HeadersSchema),
	compat: Type.Optional(ProviderCompatSchema),
});

const ModelOverrideSchema = Type.Object({
	hidden: Type.Optional(
		Type.Boolean({
			description: "When true, removes the model from the provider.",
		}),
	),
	name: Type.Optional(Type.String({ minLength: 1, description: ModelFieldDescriptions.name })),
	reasoning: Type.Optional(Type.Boolean({ description: ModelFieldDescriptions.reasoning })),
	thinkingLevelMap: Type.Optional(ThinkingLevelMapSchema),
	input: Type.Optional(Type.Array(ModelInputModalitySchema)),
	inputLimits: Type.Optional(ModelInputLimitsSchema),
	cost: Type.Optional(Type.Partial(ModelCostSchema)),
	promptCache: Type.Optional(ModelPromptCacheSchema),
	contextWindow: Type.Optional(
		Type.Number({ exclusiveMinimum: 0, description: ModelFieldDescriptions.contextWindow }),
	),
	maxTokens: Type.Optional(Type.Number({ exclusiveMinimum: 0, description: ModelFieldDescriptions.maxTokens })),
	samplingParams: Type.Optional(SamplingParamsFieldSchema),
	samplingParamsByThinkingLevel: Type.Optional(SamplingParamsByThinkingLevelSchema),
	headers: Type.Optional(HeadersSchema),
	compat: Type.Optional(ProviderCompatSchema),
});

const ProviderConfigSchema = Type.Object({
	name: Type.Optional(Type.String({ minLength: 1, description: "Display name." })),
	baseUrl: Type.Optional(
		Type.String({ minLength: 1, description: "API base URL. Also applies to the provider's built-in models." }),
	),
	apiKey: Type.Optional(
		Type.String({
			minLength: 1,
			description: 'Literal key, "$NAME" environment interpolation, or "!command" output.',
		}),
	),
	api: Type.Optional(
		Type.String({
			minLength: 1,
			description:
				'API for the provider\'s models, such as "openai-completions", "openai-responses", "anthropic-messages", or "google-generative-ai".',
		}),
	),
	oauth: Type.Optional(Type.Literal("radius", { description: "OAuth login flow. Requires baseUrl." })),
	headers: Type.Optional(HeadersSchema),
	compat: Type.Optional(ProviderCompatSchema),
	authHeader: Type.Optional(
		Type.Boolean({ default: false, description: "Whether to send the resolved API key as Authorization: Bearer." }),
	),
	models: Type.Optional(Type.Array(ModelDefinitionSchema)),
	modelOverrides: Type.Optional(Type.Record(Type.String(), ModelOverrideSchema)),
});

const ContextWindowCapSchema = Type.Integer({
	minimum: 1,
	maximum: Number.MAX_SAFE_INTEGER,
	description: "Maximum operational context window in tokens.",
});

const ContextWindowCapsSchema = Type.Object(
	{
		default: Type.Optional(ContextWindowCapSchema),
		providers: Type.Optional(
			Type.Record(Type.String({ pattern: "^[\\s\\S]+$" }), ContextWindowCapSchema, {
				description: "Per-provider ceilings, replacing the default for those provider IDs.",
				additionalProperties: false,
			}),
		),
	},
	{ additionalProperties: false },
);

const ModelsConfigProperties = {
	providers: Type.Optional(Type.Record(Type.String(), ProviderConfigSchema)),
	contextWindowCaps: Type.Optional(ContextWindowCapsSchema),
};

export const ModelsConfigSchema = Type.Object(
	{
		$schema: Type.Optional(Type.String()),
		...ModelsConfigProperties,
	},
	{ anyOf: [{ required: ["providers"] }, { required: ["contextWindowCaps"] }] },
);

/** Entry schemas rendered into docs/models-configuration.md. */
export const ModelsJsonSchemas = {
	provider: ProviderConfigSchema,
	model: ModelDefinitionSchema,
	modelOverride: ModelOverrideSchema,
	contextWindowCaps: ContextWindowCapsSchema,
};

const validateModelsConfig = Compile(ModelsConfigSchema);

export type ModelsJsonModel = Static<typeof ModelDefinitionSchema>;
export type ModelsJsonModelOverride = Static<typeof ModelOverrideSchema>;
export type ModelsJsonProvider = Static<typeof ProviderConfigSchema>;

function formatValidationPath(error: TLocalizedValidationError): string {
	if (error.keyword === "required") {
		const requiredProperties = (error.params as { requiredProperties?: string[] }).requiredProperties;
		const requiredProperty = requiredProperties?.[0];
		if (requiredProperty) {
			const basePath = error.instancePath.replace(/^\//, "").replace(/\//g, ".");
			return basePath ? `${basePath}.${requiredProperty}` : requiredProperty;
		}
	}
	const path = error.instancePath.replace(/^\//, "").replace(/\//g, ".");
	return path || "root";
}

function deepFreeze<T>(value: T): T {
	const pending: unknown[] = [value];
	while (pending.length > 0) {
		const current = pending.pop();
		if (typeof current !== "object" || current === null || Object.isFrozen(current)) continue;
		Object.freeze(current);
		for (const child of Object.values(current)) pending.push(child);
	}
	return value;
}

/** One immutable load of models.json. */
export class ModelConfig {
	private readonly providers: ReadonlyMap<string, ModelsJsonProvider>;
	private readonly contextWindowCaps: Static<typeof ContextWindowCapsSchema> | undefined;
	private readonly error: string | undefined;

	private constructor(
		providers: ReadonlyMap<string, ModelsJsonProvider>,
		error?: string,
		contextWindowCaps?: Static<typeof ContextWindowCapsSchema>,
	) {
		this.providers = providers;
		this.error = error;
		this.contextWindowCaps = contextWindowCaps;
	}

	static async load(modelsJsonPath: string | undefined): Promise<ModelConfig> {
		if (!modelsJsonPath) return new ModelConfig(new Map());
		const path = normalizePath(modelsJsonPath);
		let content: string;
		try {
			content = await readFile(path, "utf-8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return new ModelConfig(new Map());
			return new ModelConfig(
				new Map(),
				`Failed to load models.json: ${error instanceof Error ? error.message : error}\n\nFile: ${path}`,
			);
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(stripJsonComments(stripBom(content)));
		} catch (error) {
			return new ModelConfig(
				new Map(),
				`Failed to parse models.json: ${error instanceof Error ? error.message : error}\n\nFile: ${path}`,
			);
		}

		if (!validateModelsConfig.Check(parsed)) {
			const errors =
				validateModelsConfig
					.Errors(parsed)
					.map((error) => `  - ${formatValidationPath(error)}: ${error.message}`)
					.join("\n") || "Unknown schema error";
			return new ModelConfig(new Map(), `Invalid models.json schema:\n${errors}\n\nFile: ${path}`);
		}

		const providers = new Map<string, ModelsJsonProvider>();
		for (const [providerId, provider] of Object.entries(parsed.providers ?? {})) {
			providers.set(providerId, deepFreeze(provider));
		}
		return new ModelConfig(providers, undefined, parsed.contextWindowCaps && deepFreeze(parsed.contextWindowCaps));
	}

	getProvider(providerId: string): ModelsJsonProvider | undefined {
		return this.providers.get(providerId);
	}

	getProviderIds(): readonly string[] {
		return [...this.providers.keys()];
	}

	hasContextWindowCaps(): boolean {
		return this.contextWindowCaps !== undefined;
	}

	getContextWindowCap(providerId: string): number | undefined {
		const providers = this.contextWindowCaps?.providers;
		return providers && Object.hasOwn(providers, providerId)
			? providers[providerId]
			: this.contextWindowCaps?.default;
	}

	getError(): string | undefined {
		return this.error;
	}
}
