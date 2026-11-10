import { registerSessionResourceCleanup } from "../session-resources.ts";
import type { Tool } from "../types.ts";
import { makeStrictJsonSchema, requiresJsonSchemaStrictSampling } from "./constrained-sampling.ts";

/** What is left of Claude's counted limits for one request's strict tools. */
export interface StrictToolBudget {
	tools: number;
	unionParameters: number;
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
 * Starts the strict tool budget of one request to Claude. `requiredTools` holds every tool definition the request
 * sends strict because its tool requires that (`strict: "require"`). They take their share here, wherever they are
 * declared, so tools that only prefer strict sampling cannot use up the limits before them. Throws when the required
 * tools alone exceed the limits, which sending other tools non-strict cannot repair.
 */
export function startStrictToolBudget(requiredTools: Tool[]): StrictToolBudget {
	const budget = { ...CLAUDE_STRICT_TOOL_LIMITS };
	for (const tool of requiredTools) {
		if (!takeStrictToolShare(budget, tool)) {
			throw new Error(
				`Tool "${tool.name}" requires strict sampling, but the tools that require it exceed Claude's limits of ${CLAUDE_STRICT_TOOL_LIMITS.tools} strict tools and ${CLAUDE_STRICT_TOOL_LIMITS.unionParameters} union-typed parameters per request.`,
			);
		}
	}
	return budget;
}

/**
 * Returns whether a tool definition that can be strict is sent strict. Call it once per definition, in declaration
 * order: a required tool always is, its share was taken when the budget started; a preferred tool is while the
 * budget still covers it, and is sent non-strict otherwise.
 */
export function admitStrictTool(budget: StrictToolBudget, tool: Tool): boolean {
	return requiresJsonSchemaStrictSampling(tool) || takeStrictToolShare(budget, tool);
}

/** Takes one strict tool definition's share from the budget; returns false, taking nothing, when it does not fit. */
function takeStrictToolShare(budget: StrictToolBudget, tool: Tool): boolean {
	const unionParameters = countUnionParameters(makeStrictJsonSchema(tool.parameters));
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
