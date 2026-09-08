import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("wait-for-answer", {
		handler: async (_args, ctx) => {
			const answer = await ctx.ui.input("Keep this question open");
			pi.appendEntry("answer", { answer });
		},
	});

	pi.on("session_shutdown", async (event, ctx) => {
		writeFileSync(join(ctx.cwd, "shutdown-started"), event.reason);
		if (existsSync(join(ctx.cwd, "hold-shutdown"))) {
			while (!existsSync(join(ctx.cwd, "release-shutdown"))) await delay(10);
		}
		if (existsSync(join(ctx.cwd, "drain-output"))) {
			ctx.ui.notify("x".repeat(4 * 1024 * 1024));
		}
		writeFileSync(join(ctx.cwd, "shutdown-finished"), event.reason);
	});
}
