/**
 * Reload Runtime Extension
 *
 * Demonstrates ctx.reload() from ExtensionCommandContext and an LLM-callable
 * tool that queues a follow-up command to refresh resources and reinitialize
 * extensions. Extension code changes require a full Pi restart.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
	// Command entrypoint for reload.
	// Treat reload as terminal for this handler.
	pi.registerCommand("reload-runtime", {
		description: "Refresh resources and reinitialize extensions; code changes require restarting Pi",
		handler: async (_args, ctx) => {
			await ctx.reload();
			return;
		},
	});

	// LLM-callable tool. Tools get ExtensionContext, so they cannot call ctx.reload() directly.
	// Instead, queue a follow-up user command that executes the command above.
	pi.registerTool({
		name: "reload_runtime",
		label: "Reload Runtime",
		description: "Refresh resources and reinitialize extensions; code changes require restarting Pi",
		parameters: Type.Object({}),
		async execute() {
			pi.sendUserMessage("/reload-runtime", { deliverAs: "followUp" });
			return {
				content: [{ type: "text", text: "Queued /reload-runtime as a follow-up command." }],
				details: {},
			};
		},
	});
}
