/**
 * Redraws Extension
 *
 * Exposes /tui to show TUI redraw stats.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("tui", {
		description: "Show TUI stats",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) return;
			const redraws = await ctx.ui.custom<number | undefined>((tui, _theme, _keybindings, done) => {
				done(tui.fullRedraws);
				return new Text("", 0, 0);
			});
			ctx.ui.notify(
				redraws === undefined ? "TUI redraw stats are unavailable in this UI." : `TUI full redraws: ${redraws}`,
				"info",
			);
		},
	});
}
