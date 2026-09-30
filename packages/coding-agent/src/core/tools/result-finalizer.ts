/** File-producing tools defer publication until the session has applied every result hook. */
import type { AgentToolResult } from "@earendil-works/pi-agent-core";

type ResultFinalizer = (permitted: AgentToolResult<unknown>) => Promise<AgentToolResult<unknown>>;
const finalizers = new WeakMap<AgentToolResult<unknown>, ResultFinalizer>();

export function deferToolResultFinalization<T>(
	result: AgentToolResult<T>,
	finalize: ResultFinalizer,
): AgentToolResult<T> {
	finalizers.set(result, finalize);
	return result;
}

export async function finalizeToolResult(
	original: AgentToolResult<unknown>,
	permitted: AgentToolResult<unknown>,
): Promise<AgentToolResult<unknown> | undefined> {
	const finalize = finalizers.get(original);
	if (!finalize) return undefined;
	finalizers.delete(original);
	return finalize(permitted);
}
