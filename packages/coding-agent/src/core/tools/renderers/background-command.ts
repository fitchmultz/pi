import { Text } from "@earendil-works/pi-tui";
import type { TSchema } from "typebox";
import type { ToolDefinition } from "../../extensions/types.ts";
import type { BackgroundCommandToolDetails, BackgroundCommandToolInput } from "../background-command.ts";

export const backgroundCommandRenderers: Pick<
	ToolDefinition<TSchema, BackgroundCommandToolDetails>,
	"renderCall" | "renderResult"
> = {
	renderCall(rawArgs, theme) {
		const args = rawArgs as Partial<BackgroundCommandToolInput>;
		const target = args.command ?? args.id?.slice(0, 8) ?? "";
		return new Text(
			theme.fg("toolTitle", theme.bold(`background ${args.action ?? ""}`)) +
				(target ? ` ${theme.fg("muted", target)}` : ""),
			0,
			0,
		);
	},
	renderResult(result, { expanded }, theme, context) {
		const detail = result.details;
		const args = context.args as Partial<BackgroundCommandToolInput>;
		if (expanded || !detail || context.isError) {
			return new Text(
				result.content
					.filter((part) => part.type === "text")
					.map((part) => part.text)
					.join("\n"),
				0,
				0,
			);
		}
		if (!("id" in detail)) {
			return new Text(
				detail.total === 0
					? args.activeOnly
						? "No active background jobs"
						: "No background jobs"
					: `${detail.jobs.length} shown · ${detail.total} total`,
				0,
				0,
			);
		}
		const running = detail.status === "running" || detail.status === "starting";
		const label = detail.cancelRequested
			? "Cancellation requested"
			: !running
				? `Job ${detail.status}${detail.exitCode != null ? ` · exit ${detail.exitCode}` : ""}`
				: args.action === "start"
					? "Started in background"
					: `Snapshot: ${detail.status}`;
		return new Text(
			theme.fg(
				detail.status === "succeeded" ? "success" : running || detail.status === "cancelled" ? "muted" : "error",
				`${label} · ${detail.id.slice(0, 8)}`,
			),
			0,
			0,
		);
	},
};
