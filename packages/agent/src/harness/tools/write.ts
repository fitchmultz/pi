import { type Static, Type } from "typebox";
import type { AgentHarnessTool } from "../types.ts";
import { getOrThrow } from "../types.ts";
import { withFileMutationQueue } from "./file-mutation-queue.ts";
import type { ExecutionToolContext } from "./tool-context.ts";

const writeSchema = Type.Object({
	path: Type.String({ description: "Path to the file to write (relative or absolute)" }),
	content: Type.String({ description: "Content to write to the file" }),
});

export type WriteToolInput = Static<typeof writeSchema>;

export function createWriteTool<TContext extends ExecutionToolContext = ExecutionToolContext>(): AgentHarnessTool<
	TContext,
	typeof writeSchema,
	undefined
> {
	return {
		name: "write",
		label: "write",
		description:
			"Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.",
		parameters: writeSchema,
		async execute(_toolCallId, { path, content }, _onUpdate, { env }, _invocation, context) {
			return withFileMutationQueue(
				env,
				path,
				async () => {
					if (context.abortSignal?.aborted) throw new Error("Operation aborted");
					getOrThrow(await env.writeFile(path, content, context));
					return {
						content: [{ type: "text", text: `Successfully wrote to ${path}` }],
						details: undefined,
					};
				},
				context,
			);
		},
	};
}
