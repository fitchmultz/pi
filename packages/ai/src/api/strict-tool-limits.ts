import { registerSessionResourceCleanup } from "../session-resources.ts";
import type { Tool } from "../types.ts";
import {
	prefersJsonSchemaStrictSampling,
	requiresJsonSchemaStrictSampling,
	resolveStrictJsonSchema,
	type UnsupportedStrictSchemaKeywordCheck,
} from "./constrained-sampling.ts";

interface StrictToolBudget {
	tools: number;
	unionParameters: number;
}

/** Planned strict schemas and request-wide budget admission for one provider request. */
export interface StrictToolPlan {
	/**
	 * Admit one sent tool definition in declaration order. Returns its strict schema when sent strict,
	 * or `undefined` when sent non-strict.
	 */
	admit: (tool: Tool) => Tool["parameters"] | undefined;
	/**
	 * Reserve the strict budget share of an earlier summarized definition without marking the outgoing
	 * request as carrying relaxable `strict: "prefer"` definitions.
	 */
	consume: (tool: Tool) => void;
	/** True when at least one sent definition used `strict: "prefer"` and can be relaxed on retry. */
	readonly hasPreferredStrictTools: boolean;
}

export interface PlanStrictToolsOptions {
	supportsStrictMode: boolean;
	disablePreferred: boolean;
	/** Apply Claude's 20-tool / 16-union request-wide limits. Defaults to `true`. */
	applyClaudeLimits?: boolean;
	isUnsupportedKeyword?: UnsupportedStrictSchemaKeywordCheck;
}

/**
 * Claude's limits on the strict tools of one request, on the Anthropic API and on Bedrock:
 * https://platform.claude.com/docs/en/build-with-claude/structured-outputs#schema-complexity-limits
 * `unionParameters` counts the parameters with an `anyOf` or a type array over all strict tools; a strict schema
 * turns an optional parameter into one. The third documented limit, 24 optional parameters, cannot bind: a strict
 * schema requires every property.
 */
const CLAUDE_STRICT_TOOL_LIMITS: Readonly<StrictToolBudget> = { tools: 20, unionParameters: 16 };

/**
 * Claude rejects a request whose strict tools exceed its limits with one of these messages. The last two report the
 * counted limits above; the first reports a compiled grammar size that no count predicts.
 */
const STRICT_TOOL_LIMIT_ERROR_MESSAGES = [
	"The compiled grammar is too large",
	"Too many strict tools (",
	"Schemas contains too many parameters with union types (",
];

/** Returns true when a provider error message says the request's strict tools exceed the provider's limits. */
export function isStrictToolLimitErrorMessage(message: string): boolean {
	return STRICT_TOOL_LIMIT_ERROR_MESSAGES.some((limitMessage) => message.includes(limitMessage));
}

/**
 * Plans strict JSON-schema sampling across one request's tool definitions, building each candidate
 * strict schema at most once. When `applyClaudeLimits` is enabled (default), tools with
 * `strict: "require"` reserve their share up front so `strict: "prefer"` tools cannot crowd them out;
 * throws when the required tools alone exceed Claude's limits.
 */
export function planStrictTools(tools: readonly Tool[], options: PlanStrictToolsOptions): StrictToolPlan {
	const schemas = new Map<Tool, Tool["parameters"] | null>();
	const getStrictSchema = (tool: Tool): Tool["parameters"] | undefined => {
		const cached = schemas.get(tool);
		if (cached !== undefined) return cached ?? undefined;
		if (options.disablePreferred && prefersJsonSchemaStrictSampling(tool)) {
			schemas.set(tool, null);
			return undefined;
		}
		const schema = resolveStrictJsonSchema(tool, options.supportsStrictMode, options.isUnsupportedKeyword);
		schemas.set(tool, schema ?? null);
		return schema;
	};

	const budget = options.applyClaudeLimits === false ? undefined : { ...CLAUDE_STRICT_TOOL_LIMITS };
	if (budget) {
		for (const tool of tools) {
			if (!requiresJsonSchemaStrictSampling(tool)) continue;
			const schema = getStrictSchema(tool);
			if (schema && !takeStrictSchemaShare(budget, schema)) {
				throw new Error(
					`Tool "${tool.name}" requires strict sampling, but the tools that require it exceed Claude's limits of ${CLAUDE_STRICT_TOOL_LIMITS.tools} strict tools and ${CLAUDE_STRICT_TOOL_LIMITS.unionParameters} union-typed parameters per request.`,
				);
			}
		}
	}

	const tryTake = (tool: Tool): Tool["parameters"] | undefined => {
		const schema = getStrictSchema(tool);
		if (!schema) return undefined;
		if (budget && !requiresJsonSchemaStrictSampling(tool) && !takeStrictSchemaShare(budget, schema)) {
			return undefined;
		}
		return schema;
	};

	let hasPreferredStrictTools = false;
	return {
		admit: (tool) => {
			const schema = tryTake(tool);
			if (schema && prefersJsonSchemaStrictSampling(tool)) hasPreferredStrictTools = true;
			return schema;
		},
		consume: (tool) => {
			tryTake(tool);
		},
		get hasPreferredStrictTools() {
			return hasPreferredStrictTools;
		},
	};
}

/** Takes one strict tool definition's share from the budget; returns false, taking nothing, when it does not fit. */
function takeStrictSchemaShare(budget: StrictToolBudget, schema: unknown): boolean {
	const unionParameters = countUnionParameters(schema);
	if (budget.tools === 0 || unionParameters > budget.unionParameters) return false;
	budget.tools--;
	budget.unionParameters -= unionParameters;
	return true;
}

/** Counts the parameters Claude counts as unions: properties and array items with an `anyOf` or a type array, at any depth. */
function countUnionParameters(schema: unknown): number {
	if (typeof schema !== "object" || schema === null) return 0;
	const { properties, items, anyOf } = schema as {
		properties?: Record<string, unknown>;
		items?: unknown;
		anyOf?: unknown[];
	};
	let count = 0;
	for (const child of [...Object.values(properties ?? {}), ...(items === undefined ? [] : [items])]) {
		const { anyOf: union, type } = (child ?? {}) as { anyOf?: unknown; type?: unknown };
		if (Array.isArray(union) || Array.isArray(type)) count++;
		count += countUnionParameters(child);
	}
	for (const variant of anyOf ?? []) count += countUnionParameters(variant);
	return count;
}

/**
 * Sessions whose strict tools Claude rejected for exceeding its limits. Their later requests send `strict: "prefer"`
 * tools non-strict right away: the tool set rarely changes between turns, so trying strict again would only repeat
 * the rejection, and switching back to strict later would rewrite the tool definitions and miss the prompt cache.
 * Shared by the Anthropic and Bedrock providers, which run the same Claude limits.
 */
const sessionsOverStrictToolLimits = new Set<string>();
const MAX_SESSIONS_OVER_STRICT_TOOL_LIMITS = 10_000;

/**
 * Records that a session's strict tools exceeded Claude's limits; does nothing without a session. Keeps at most
 * `MAX_SESSIONS_OVER_STRICT_TOOL_LIMITS` sessions.
 *
 * Entries are normally freed by `cleanupSessionResources(sessionId)` when a session ends. The cap bounds memory for
 * library users that never call it; a dropped session just pays one more rejection.
 */
export function markStrictToolLimitsExceeded(sessionId: string | undefined): void {
	if (sessionId === undefined) return;
	sessionsOverStrictToolLimits.add(sessionId);
	if (sessionsOverStrictToolLimits.size > MAX_SESSIONS_OVER_STRICT_TOOL_LIMITS) {
		const oldest = sessionsOverStrictToolLimits.values().next().value;
		if (oldest !== undefined) sessionsOverStrictToolLimits.delete(oldest);
	}
}

/** Returns true when an earlier request of this session had its strict tools rejected for exceeding Claude's limits. */
export function hasExceededStrictToolLimits(sessionId: string | undefined): boolean {
	return sessionId !== undefined && sessionsOverStrictToolLimits.has(sessionId);
}

registerSessionResourceCleanup((sessionId) => {
	if (sessionId) sessionsOverStrictToolLimits.delete(sessionId);
	else sessionsOverStrictToolLimits.clear();
});
