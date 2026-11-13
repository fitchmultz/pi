import type { CompactionSummaryMessage } from "../../../core/messages.ts";
import { SummaryMessageComponent } from "./summary-message.ts";

/**
 * Component that renders a compaction message with collapsed/expanded state.
 * Uses same background color as custom messages for visual consistency.
 */
export class CompactionSummaryMessageComponent extends SummaryMessageComponent<CompactionSummaryMessage> {
	protected override getSummaryDisplay() {
		const tokenStr = this.message.tokensBefore.toLocaleString();
		return {
			tag: "compaction",
			expandedHeader: `**Compacted from ${tokenStr} tokens**\n\n`,
			collapsedLabel: `Compacted from ${tokenStr} tokens`,
		};
	}
}
